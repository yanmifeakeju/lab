// Drives a whole connection, keys in and frames out, through OpenTUI's test
// renderer: screens, session, and the generated client over a fake plane.
// Runs under Bun, which compiles the JSX.

import assert from "node:assert/strict"
import { test } from "node:test"

import { createTestRenderer } from "@opentui/core/testing"
import { Effect, Fiber } from "effect"

import { connect } from "../src/connection.tsx"
import { active, business, failure, fakePlane, inTurn, me, type Reply, scenario } from "./support.ts"

const opened = business({
  status: "active",
  holder_ref: "hld_1",
  ledger: { slug: "ngn_ng", currency: "NGN", scale: 2, payable_account_ref: "acct_01K33YV8M82N9MXP4E7J6B1QWK" },
})

// A connection on a test terminal, with handles to type into it, read it,
// and close it the way an SSH disconnect would.
const paths = (plane: ReturnType<typeof fakePlane>) => plane.calls.map(({ method, path }) => `${method} ${path}`)

const screen = Effect.fnUntraced(function* (plane: ReturnType<typeof fakePlane>) {
  const setup = yield* Effect.promise(() => createTestRenderer({ width: 70, height: 20 }))
  const closers: Array<() => void> = []
  let ended = 0

  const fiber = yield* Effect.forkChild(
    connect(
      "SHA256:key",
      setup.renderer,
      (callback) => closers.push(callback),
      () => {
        ended += 1
      },
    ).pipe(Effect.provide(plane.layer)),
  )

  const draw = Effect.andThen(
    Effect.promise(() => setup.renderOnce()),
    Effect.sync(() => setup.captureCharFrame()),
  )

  // OpenTUI's own waits stop once the renderer is idle, which it is while a
  // request is out, so this polls instead.
  const until = Effect.fnUntraced(function* (done: (frame: string) => boolean, what: string) {
    let frame = ""

    for (let attempt = 0; attempt < 200; attempt++) {
      frame = yield* draw

      if (done(frame)) {
        return frame
      }

      yield* Effect.sleep("10 millis")
    }

    return yield* Effect.die(new Error(`never ${what}; last frame:\n${frame}`))
  })

  return {
    setup,
    fiber,
    showing: (text: string) => until((frame) => frame.includes(text), `showed ${text}`),
    matching: (done: (frame: string) => boolean) => until(done, "matched"),
    endedTimes: (times: number) => until(() => ended === times, `ended ${times} times`),
    keys: setup.mockInput,
    close: () => closers.forEach((close) => close()),
    // Lets queued work land, then draws, for asserting what isn't there.
    frame: Effect.andThen(Effect.sleep("50 millis"), draw),
  }
})

void test(
  "a new key creates its business from the form, then opens its account",
  scenario(
    Effect.gen(function* () {
      const plane = fakePlane({
        me: me(null),
        createBusiness: () => ({ status: 200, body: business() }),
        openLedger: () => ({ status: 200, body: opened }),
      })

      const tui = yield* screen(plane)

      yield* tui.showing("Create your business")
      yield* tui.showing("Country: Nigeria")
      yield* Effect.promise(() => tui.keys.typeText("Acme Ltd"))
      tui.keys.pressEnter()
      yield* tui.showing("Press o to open your account.")

      assert.deepEqual(plane.calls.find(({ path }) => path === "/business")?.body, { name: "Acme Ltd", country_code: "NG" })

      tui.keys.pressKey("o")

      const frame = yield* tui.showing("Account acct_01K33YV8M82N9MXP4E7J6B1QWK in ngn_ng")

      assert.match(frame, /Nigeria · NGN/)
      assert.doesNotMatch(frame, /Press o/)

      tui.close()
      yield* Fiber.join(tui.fiber)
    }),
  ),
)

void test(
  "letters typed into the form are a name, not commands",
  scenario(
    Effect.gen(function* () {
      const plane = fakePlane({ me: me(null), createBusiness: () => ({ status: 200, body: business() }) })
      const tui = yield* screen(plane)

      yield* tui.showing("Create your business")
      yield* Effect.promise(() => tui.keys.typeText("orrrr"))
      yield* tui.showing("orrrr")

      assert.deepEqual(plane.calls.map(({ path }) => path), ["/session", "/me"])

      tui.close()
      yield* Fiber.join(tui.fiber)
    }),
  ),
)

void test(
  "a refused create shows a popup that takes the keys, and Close brings back what was typed",
  scenario(
    Effect.gen(function* () {
      const plane = fakePlane({ me: me(null), createBusiness: () => failure(503, "country_unavailable") })
      const tui = yield* screen(plane)

      yield* tui.showing("Create your business")
      yield* Effect.promise(() => tui.keys.typeText("Acme Ltd"))
      tui.keys.pressEnter()

      const popup = yield* tui.showing("Businesses can't be created in this country yet.")

      assert.match(popup, /\[Enter\/Esc\] Close/)
      assert.doesNotMatch(popup, /Retry/)

      // Typed at the popup, not the form.
      yield* Effect.promise(() => tui.keys.typeText("xyz"))
      tui.keys.pressEscape()

      const frame = yield* tui.matching((shown) => !shown.includes("Error") && shown.includes("Create your business"))

      assert.match(frame, /Acme Ltd/)
      assert.doesNotMatch(frame, /xyz/)
      assert.deepEqual(paths(plane), ["POST /session", "GET /me", "POST /business", "GET /me"])

      tui.close()
      yield* Fiber.join(tui.fiber)
    }),
  ),
)

void test(
  "a failed load offers Retry alone, and Enter retries",
  scenario(
    Effect.gen(function* () {
      const plane = fakePlane({ me: inTurn({ status: 500, body: {} }, me(active)()) })
      const tui = yield* screen(plane)

      const popup = yield* tui.showing("Couldn't load your account.")

      assert.match(popup, /\[Enter\] Retry/)
      assert.doesNotMatch(popup, /Close/)
      assert.doesNotMatch(popup, /Create your business/)

      tui.keys.pressEscape()
      tui.keys.pressEnter()
      yield* tui.showing("Acme Ltd")

      const frame = yield* tui.frame

      assert.doesNotMatch(frame, /Create your business|Error/)
      assert.match(frame, /Account acct_1 in ngn_ng/)
      assert.deepEqual(paths(plane), ["POST /session", "GET /me", "GET /me"])

      tui.close()
      yield* Fiber.join(tui.fiber)
    }),
  ),
)

void test(
  "a temporary ledger failure offers Retry and Close, and Enter retries",
  scenario(
    Effect.gen(function* () {
      const plane = fakePlane({
        me: me(business()),
        openLedger: inTurn(failure(503, "ledger_unavailable"), { status: 200, body: opened }),
      })

      const tui = yield* screen(plane)

      yield* tui.showing("Press o to open your account.")
      tui.keys.pressKey("o")

      const popup = yield* tui.showing("Couldn't open the account.")

      assert.match(popup, /\[Enter\] Retry/)
      assert.match(popup, /\[Esc\] Close/)

      tui.keys.pressEnter()

      const frame = yield* tui.showing("Account acct_01K33YV8M82N9MXP4E7J6B1QWK")

      assert.doesNotMatch(frame, /Error/)

      tui.close()
      yield* Fiber.join(tui.fiber)
    }),
  ),
)

void test(
  "a ledger refusal is Close-only, o can't resend it, and Close shows the business alone",
  scenario(
    Effect.gen(function* () {
      for (const code of ["conflict", "ledger_rejected"]) {
        const plane = fakePlane({ me: me(business()), openLedger: () => failure(409, code) })
        const tui = yield* screen(plane)

        yield* tui.showing("Press o to open your account.")
        tui.keys.pressKey("o")

        const popup = yield* tui.showing("Contact support.")

        assert.doesNotMatch(popup, /Retry/)

        tui.keys.pressKey("o")
        yield* tui.frame

        assert.deepEqual(paths(plane), ["POST /session", "GET /me", "POST /business/biz_1/ledger"], code)

        tui.keys.pressEscape()

        const frame = yield* tui.matching((shown) => !shown.includes("Error") && shown.includes("Press o"))

        assert.doesNotMatch(frame, /Contact support/)
        assert.deepEqual(
          paths(plane),
          ["POST /session", "GET /me", "POST /business/biz_1/ledger", "GET /me"],
          code,
        )

        tui.close()
        yield* Fiber.join(tui.fiber)
      }
    }),
  ),
)

void test(
  "closing the connection while a popup's refresh is out cancels it",
  scenario(
    Effect.gen(function* () {
      const plane = fakePlane({ me: inTurn(me(business())(), "hang"), openLedger: () => failure(409, "conflict") })
      const tui = yield* screen(plane)

      yield* tui.showing("Press o to open your account.")
      tui.keys.pressKey("o")
      yield* tui.showing("Contact support.")
      tui.keys.pressEscape()
      yield* tui.showing("Loading…")

      tui.close()

      yield* Fiber.join(tui.fiber).pipe(Effect.timeout("2 seconds"))
    }),
  ),
)

void test(
  "Ctrl+C and Ctrl+D ask to end the connection",
  scenario(
    Effect.gen(function* () {
      const tui = yield* screen(fakePlane({ me: me(active) }))

      yield* tui.showing("Acme Ltd")
      tui.keys.pressCtrlC()
      tui.keys.pressKey("d", { ctrl: true })

      yield* tui.endedTimes(2)

      tui.close()
      yield* Fiber.join(tui.fiber)
    }),
  ),
)

void test(
  "closing the connection cancels a request still in flight",
  scenario(
    Effect.gen(function* () {
      const hang: Reply = "hang"
      const tui = yield* screen(fakePlane({ me: () => hang }))

      yield* tui.showing("Loading…")
      yield* Effect.sleep("50 millis")

      tui.close()

      // Joins only because the hung request was interrupted.
      yield* Fiber.join(tui.fiber).pipe(Effect.timeout("2 seconds"))
    }),
  ),
)

void test(
  "resizing redraws the screen to the new size",
  scenario(
    Effect.gen(function* () {
      const tui = yield* screen(fakePlane({ me: me(active) }))

      yield* tui.showing("Acme Ltd")
      tui.setup.resize(40, 12)

      const frame = yield* tui.frame
      const rows = frame.split("\n").filter((row) => row.length > 0)

      assert.match(frame, /Acme Ltd/)
      assert.equal(rows.length, 12)
      // Box-drawing characters are one UTF-16 unit each.
      assert.ok(rows.every((row) => row.length === 40))

      tui.close()
      yield* Fiber.join(tui.fiber)
    }),
  ),
)
