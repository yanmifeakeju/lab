// Drives a whole connection, keys in and frames out, through OpenTUI's test
// renderer: screens, session, and the generated client over a fake plane.
// Runs under Bun, which compiles the JSX.

import assert from "node:assert/strict"
import { test } from "node:test"

import { createTestRenderer } from "@opentui/core/testing"
import { Effect, Fiber } from "effect"

import { connect } from "../src/connection.tsx"
import { active, business, createdLink, failure, fakePlane, first, inTurn, me, type Reply, scenario } from "./support.ts"

const opened = business({
  status: "active",
  holder_ref: "hld_1",
  ledger: { slug: "ngn_ng", currency: "NGN", scale: 2, payable_account_ref: "acct_01K33YV8M82N9MXP4E7J6B1QWK" },
})

// A connection on a test terminal, with handles to type into it, read it,
// and close it the way an SSH disconnect would.
const paths = (plane: ReturnType<typeof fakePlane>) => plane.calls.map(({ method, path }) => `${method} ${path}`)

const screen = Effect.fnUntraced(function* (plane: ReturnType<typeof fakePlane>, size = { width: 70, height: 20 }) {
  const setup = yield* Effect.promise(() => createTestRenderer(size))
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
      (shareToken) => `ssh ${shareToken}@tui.test`,
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
        openAccount: () => ({ status: 200, body: opened }),
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
        openAccount: inTurn(failure(503, "ledger_unavailable"), { status: 200, body: opened }),
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
        const plane = fakePlane({ me: me(business()), openAccount: () => failure(409, code) })
        const tui = yield* screen(plane)

        yield* tui.showing("Press o to open your account.")
        tui.keys.pressKey("o")

        const popup = yield* tui.showing("Contact support.")

        assert.doesNotMatch(popup, /Retry/)

        tui.keys.pressKey("o")
        yield* tui.frame

        assert.deepEqual(paths(plane), ["POST /session", "GET /me", "POST /account"], code)

        tui.keys.pressEscape()

        const frame = yield* tui.matching((shown) => !shown.includes("Error") && shown.includes("Press o"))

        assert.doesNotMatch(frame, /Contact support/)
        assert.deepEqual(
          paths(plane),
          ["POST /session", "GET /me", "POST /account", "GET /me"],
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
      const plane = fakePlane({ me: inTurn(me(business())(), "hang"), openAccount: () => failure(409, "conflict") })
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

const links = (plane: ReturnType<typeof fakePlane>) => plane.calls.filter(({ path }) => path.endsWith("/payment_links"))

void test(
  "p opens the link form; a fixed link is created from the keyboard and shown, and Esc goes back",
  scenario(
    Effect.gen(function* () {
      const plane = fakePlane({ me: me(active), createPaymentLink: createdLink() })
      const tui = yield* screen(plane)

      yield* tui.showing("press p to create a payment link")
      tui.keys.pressKey("p")

      const form = yield* tui.showing("Create payment link")

      assert.ok(showsField(form, "Pricing", "Fixed amount"))
      assert.match(form, /Currency: NGN/)

      yield* Effect.promise(() => tui.keys.typeText("Consulting"))
      tui.keys.pressTab()
      tui.keys.pressTab()
      tui.keys.pressTab()
      yield* Effect.promise(() => tui.keys.typeText("2,500"))
      tui.keys.pressEnter()

      const result = yield* tui.showing("Payment link created")

      assert.match(result, /Consulting/)
      assert.match(result, /Amount: ₦2,500\.00 · NGN/)
      assert.match(result, /Reference: plink_01K33YV8M82N9MXP4E7J6B1QWK/)
      assert.match(result, /ssh tok@tui\.test/)
      assert.doesNotMatch(result, /pay\.test/)
      assert.deepEqual(links(plane).map(({ body }) => body), [
        { title: "Consulting", description: null, pricing: { mode: "fixed", amount_minor: 250_000 } },
      ])

      tui.keys.pressEscape()
      yield* tui.showing("press p to create a payment link")

      tui.close()
      yield* Fiber.join(tui.fiber)
    }),
  ),
)

void test(
  "switching to customer chooses clears the amount, and an open or suggested amount can be created",
  scenario(
    Effect.gen(function* () {
      const plane = fakePlane({ me: me(active), createPaymentLink: createdLink() })
      const tui = yield* screen(plane)

      yield* tui.showing("press p to create a payment link")
      tui.keys.pressKey("p")
      yield* tui.showing("Create payment link")
      yield* Effect.promise(() => tui.keys.typeText("Community fundraiser"))
      tui.keys.pressTab()
      yield* Effect.promise(() => tui.keys.typeText("Help equip the library"))
      tui.keys.pressTab()
      tui.keys.pressTab()
      yield* Effect.promise(() => tui.keys.typeText("999"))
      yield* tui.showing("999")

      // Back to the pricing row, then over to the other mode.
      tui.keys.pressTab({ shift: true })
      tui.keys.pressArrow("right")

      const switched = yield* tui.showing("Suggested (optional)")

      assert.match(switched, /Customer chooses/)
      assert.match(switched, /Minimum \(optional\)/)
      assert.match(switched, /Maximum \(optional\)/)

      tui.keys.pressArrow("left")
      yield* tui.matching((frame) => showsField(frame, "Pricing", "‹ Fixed amount ›"))

      assert.doesNotMatch(yield* tui.frame, /999/)

      tui.keys.pressArrow("right")
      tui.keys.pressTab()
      yield* Effect.promise(() => tui.keys.typeText("2500"))
      tui.keys.pressEnter()

      const result = yield* tui.showing("Payment link created")

      assert.match(result, /Help equip the library/)
      assert.match(result, /Amount: Customer chooses · NGN/)
      assert.match(result, /Suggested: ₦2,500\.00/)
      assert.doesNotMatch(result, /Minimum|Maximum/)
      assert.deepEqual(links(plane).map(({ body }) => body), [
        {
          title: "Community fundraiser",
          description: "Help equip the library",
          pricing: { mode: "customer_chooses", suggested_amount_minor: 250_000, minimum_amount_minor: null, maximum_amount_minor: null },
        },
      ])

      tui.close()
      yield* Fiber.join(tui.fiber)
    }),
  ),
)

void test(
  "Esc on the form creates nothing, and a business without an open account offers no form",
  scenario(
    Effect.gen(function* () {
      const plane = fakePlane({ me: me(active), createPaymentLink: createdLink() })
      const tui = yield* screen(plane)

      yield* tui.showing("press p to create a payment link")
      tui.keys.pressKey("p")
      yield* tui.showing("Create payment link")
      yield* Effect.promise(() => tui.keys.typeText("Consulting"))
      tui.keys.pressEscape()
      yield* tui.showing("press p to create a payment link")

      assert.equal(links(plane).length, 0)

      tui.close()
      yield* Fiber.join(tui.fiber)

      const unopened = fakePlane({ me: me(business()), createPaymentLink: createdLink() })
      const other = yield* screen(unopened)

      yield* other.showing("Payment links need it.")
      other.keys.pressKey("p")

      assert.doesNotMatch(yield* other.frame, /Create payment link/)

      other.close()
      yield* Fiber.join(other.fiber)
    }),
  ),
)

void test(
  "a failed creation offers Retry with the same key; Close keeps the form as typed",
  scenario(
    Effect.gen(function* () {
      const plane = fakePlane({ me: me(active), createPaymentLink: first("unreachable", "unreachable")(createdLink()) })
      const tui = yield* screen(plane)

      yield* tui.showing("press p to create a payment link")
      tui.keys.pressKey("p")
      yield* tui.showing("Create payment link")
      yield* Effect.promise(() => tui.keys.typeText("Consulting"))
      tui.keys.pressTab()
      tui.keys.pressTab()
      tui.keys.pressTab()
      yield* Effect.promise(() => tui.keys.typeText("2500"))
      tui.keys.pressEnter()

      const popup = yield* tui.showing("Couldn't create the payment link.")

      assert.match(popup, /\[Enter\] Retry/)
      assert.match(popup, /\[Esc\] Close/)

      tui.keys.pressEnter()
      yield* tui.matching((frame) => links(plane).length === 2 && frame.includes("Couldn't create"))

      // Typed at the popup, not the form.
      yield* Effect.promise(() => tui.keys.typeText("xyz"))
      tui.keys.pressEscape()

      const form = yield* tui.matching((frame) => !frame.includes("Error") && frame.includes("Create payment link"))

      assert.match(form, /Consulting/)
      assert.match(form, /2500/)
      assert.doesNotMatch(form, /xyz/)

      tui.keys.pressEnter()
      yield* tui.showing("Payment link created")

      const keys = links(plane).map(({ idempotencyKey }) => idempotencyKey)

      assert.equal(keys.length, 3)
      assert.equal(new Set(keys).size, 1)

      tui.close()
      yield* Fiber.join(tui.fiber)
    }),
  ),
)

void test(
  "an invalid amount is explained before anything is sent",
  scenario(
    Effect.gen(function* () {
      const plane = fakePlane({ me: me(active), createPaymentLink: createdLink() })
      const tui = yield* screen(plane)

      yield* tui.showing("press p to create a payment link")
      tui.keys.pressKey("p")
      yield* tui.showing("Create payment link")
      yield* Effect.promise(() => tui.keys.typeText("Consulting"))
      tui.keys.pressEnter()

      const popup = yield* tui.showing("Enter the amount.")

      assert.match(popup, /\[Enter\/Esc\] Close/)

      tui.keys.pressEnter()
      yield* tui.matching((frame) => !frame.includes("Error") && frame.includes("Create payment link"))

      assert.equal(links(plane).length, 0)

      tui.close()
      yield* Fiber.join(tui.fiber)
    }),
  ),
)

void test(
  "the form redraws on resize, and closing while a creation is out cancels it",
  scenario(
    Effect.gen(function* () {
      const plane = fakePlane({ me: me(active), createPaymentLink: () => "hang" })
      const tui = yield* screen(plane)

      yield* tui.showing("press p to create a payment link")
      tui.keys.pressKey("p")
      yield* tui.showing("Create payment link")

      tui.setup.resize(60, 30)

      const frame = yield* tui.frame
      const rows = frame.split("\n").filter((row) => row.length > 0)

      assert.match(frame, /Create payment link/)
      assert.equal(rows.length, 30)

      yield* Effect.promise(() => tui.keys.typeText("Consulting"))
      tui.keys.pressTab()
      tui.keys.pressTab()
      tui.keys.pressTab()
      yield* Effect.promise(() => tui.keys.typeText("1"))
      tui.keys.pressEnter()
      yield* tui.showing("Creating your payment link…")

      // Esc and Enter are ignored while it's out.
      tui.keys.pressEscape()
      tui.keys.pressEnter()

      assert.match(yield* tui.frame, /Creating your payment link…/)
      assert.equal(links(plane).length, 1)

      tui.close()

      yield* Fiber.join(tui.fiber).pipe(Effect.timeout("2 seconds"))
    }),
  ),
)

const small = { width: 40, height: 12 }

// The row holding `label`, and the one after it, where its input draws.
const fieldRows = (frame: string, label: string) => {
  const rows = frame.split("\n")
  const at = rows.findIndex((row) => row.includes(label))

  return at === -1 ? undefined : [rows[at] ?? "", rows[at + 1] ?? ""]
}

// The label is on a row of its own, so nothing has drawn over it.
const showsField = (frame: string, label: string, value: string) => {
  const rows = fieldRows(frame, label)

  return rows !== undefined && rows[0].replace(/[│▀▄█ ]/g, "") === label.replace(/ /g, "") && rows[1].includes(value)
}

// The smallest sizes the form allows, and one with room for spacing.
for (const size of [{ width: 32, height: 10 }, { width: 40, height: 10 }, small]) {
  void test(
    `at ${size.width}×${size.height} every field of both modes scrolls into view with its label and value`,
    scenario(
      Effect.gen(function* () {
        const plane = fakePlane({ me: me(active), createPaymentLink: createdLink() })
        const tui = yield* screen(plane, size)

        yield* tui.showing("press p to")
        tui.keys.pressKey("p")
        yield* tui.showing("Create payment link")
        yield* Effect.promise(() => tui.keys.typeText("Fundraiser"))
        yield* tui.matching((frame) => showsField(frame, "Title", "Fundraiser"))
        tui.keys.pressTab()
        yield* Effect.promise(() => tui.keys.typeText("For the library"))
        yield* tui.matching((frame) => showsField(frame, "Description (optional)", "For the library"))
        tui.keys.pressTab()
        yield* tui.matching((frame) => showsField(frame, "Pricing", "‹ Fixed amount ›"))
        tui.keys.pressTab()
        yield* Effect.promise(() => tui.keys.typeText("12"))
        yield* tui.matching((frame) => showsField(frame, "Amount", "12"))

        // Back to the pricing row and over to the other mode.
        tui.keys.pressTab({ shift: true })
        tui.keys.pressArrow("right")
        yield* tui.matching((frame) => showsField(frame, "Pricing", "‹ Customer chooses ›"))

        const settings = [
          ["Suggested (optional)", "30"],
          ["Minimum (optional)", "20"],
          ["Maximum (optional)", "40"],
        ] as const

        for (const [label, value] of settings) {
          tui.keys.pressTab()
          yield* Effect.promise(() => tui.keys.typeText(value))

          const frame = yield* tui.matching((shown) => showsField(shown, label, value))

          assert.match(frame, /Create payment link/)
          assert.match(frame, /Tab/)
        }

        // Wrapping round to the top brings the title back.
        tui.keys.pressTab()
        yield* tui.matching((frame) => showsField(frame, "Title", "Fundraiser"))
        tui.keys.pressEnter()

        const result = yield* tui.showing("Payment link created")

        assert.match(result, /\[Esc\] Back/)
        assert.deepEqual(links(plane)[0]?.body, {
          title: "Fundraiser",
          description: "For the library",
          pricing: { mode: "customer_chooses", suggested_amount_minor: 3_000, minimum_amount_minor: 2_000, maximum_amount_minor: 4_000 },
        })

        tui.close()
        yield* Fiber.join(tui.fiber)
      }),
    ),
  )
}

void test(
  "a long description wraps without covering the pricing, reference, or URL, and a small result scrolls",
  scenario(
    Effect.gen(function* () {
      const description = "Help equip our community library with books and learning materials. ".repeat(7).trim()
      const plane = fakePlane({ me: me(active), createPaymentLink: createdLink() })
      const tui = yield* screen(plane)

      yield* tui.showing("press p to")
      tui.keys.pressKey("p")
      yield* tui.showing("Create payment link")
      yield* Effect.promise(() => tui.keys.typeText("Community fundraiser"))
      tui.keys.pressTab()
      yield* Effect.promise(() => tui.keys.typeText(description))
      tui.keys.pressTab()
      tui.keys.pressTab()
      yield* Effect.promise(() => tui.keys.typeText("2500"))
      tui.keys.pressEnter()

      // Rows without the border, or the scrollbar now that the details overflow.
      const cleaned = (frame: string) => frame.split("\n").map((row) => row.replace(/^│ /, "").replace(/ *█? *│$/, ""))

      const rows = cleaned(yield* tui.showing("Payment link created"))

      // Each detail on a row of its own, with all of the description above them.
      assert.ok(rows.includes("Community fundraiser"))
      assert.ok(rows.includes("Amount: ₦2,500.00 · NGN"))
      assert.ok(rows.includes("Reference: plink_01K33YV8M82N9MXP4E7J6B1QWK"))
      assert.ok(rows.some((row) => row.startsWith("[Esc] Back")))
      assert.equal(
        rows.slice(rows.indexOf("Community fundraiser") + 1, rows.indexOf("Amount: ₦2,500.00 · NGN")).join(" "),
        description,
      )

      // How customers pay it comes last, below the reference.
      for (let step = 0; step < 5; step++) {
        tui.keys.pressArrow("down")
      }

      const end = cleaned(yield* tui.showing("ssh tok@tui.test"))

      // SSH is the only way to pay, so the link's URL isn't shown.
      assert.ok(!end.some((row) => row.includes("pay.test")))
      assert.ok(end.indexOf("ssh tok@tui.test") > end.indexOf("Reference: plink_01K33YV8M82N9MXP4E7J6B1QWK"))

      for (let step = 0; step < 5; step++) {
        tui.keys.pressArrow("up")
      }

      // Too tall for 40×12: Back stays put while the details scroll.
      tui.setup.resize(small.width, small.height)

      const top = yield* tui.matching((frame) => frame.includes("Community fundraiser") && !frame.includes("ssh tok@"))

      assert.match(top, /\[Esc\] Back/)

      for (let step = 0; step < 20; step++) {
        tui.keys.pressArrow("down")
      }

      const bottom = yield* tui.showing("ssh tok@tui.test")

      assert.match(bottom, /\[Esc\] Back/)
      assert.match(bottom, /plink_01K33YV8M82N9MXP4E7J6B1QWK/)

      tui.close()
      yield* Fiber.join(tui.fiber)
    }),
  ),
)

void test(
  "below the minimum size the form asks for room, and growing back keeps the drafts, focus, and request",
  scenario(
    Effect.gen(function* () {
      const plane = fakePlane({ me: me(active), createPaymentLink: first("hang")(createdLink()) })
      const tui = yield* screen(plane, small)

      yield* tui.showing("press p to")
      tui.keys.pressKey("p")
      yield* tui.showing("Create payment link")
      yield* Effect.promise(() => tui.keys.typeText("Consulting"))
      tui.keys.pressTab()
      tui.keys.pressTab()
      tui.keys.pressTab()
      yield* Effect.promise(() => tui.keys.typeText("2500"))
      yield* tui.matching((frame) => showsField(frame, "Amount", "2500"))

      tui.setup.resize(30, 8)

      const prompt = yield* tui.showing("Enlarge the terminal to")

      assert.doesNotMatch(prompt, /Create payment link/)

      tui.setup.resize(small.width, small.height)

      // Still on the amount, which still holds what was typed.
      yield* tui.matching((frame) => showsField(frame, "Amount", "2500"))
      yield* Effect.promise(() => tui.keys.typeText("0"))
      yield* tui.matching((frame) => showsField(frame, "Amount", "25000"))
      tui.keys.pressEnter()
      yield* tui.showing("Creating your payment link…")

      // A resize while it's out leaves it out.
      tui.setup.resize(30, 8)
      yield* tui.showing("Enlarge the terminal to")
      tui.setup.resize(70, 20)
      yield* tui.showing("Creating your payment link…")

      assert.deepEqual(links(plane).map(({ body }) => body), [
        { title: "Consulting", description: null, pricing: { mode: "fixed", amount_minor: 2_500_000 } },
      ])

      tui.close()
      yield* Fiber.join(tui.fiber).pipe(Effect.timeout("2 seconds"))
    }),
  ),
)

void test(
  "at 40×12 a popup fits inside the screen and keeps its keys",
  scenario(
    Effect.gen(function* () {
      const plane = fakePlane({ me: me(active), createPaymentLink: createdLink() })
      const tui = yield* screen(plane, small)

      yield* tui.showing("press p to")
      tui.keys.pressKey("p")
      yield* tui.showing("Create payment link")
      tui.keys.pressEnter()

      const popup = yield* tui.showing("Enter a title.")
      const rows = popup.split("\n").filter((row) => row.length > 0)

      assert.match(popup, /\[Enter\/Esc\] Close/)
      // The screen's bottom border is intact under the popup.
      assert.match(rows.at(-1) ?? "", /^└─+┘$/)

      tui.keys.pressEscape()
      yield* tui.matching((frame) => !frame.includes("Error") && showsField(frame, "Title", "Community fundraiser"))

      assert.equal(links(plane).length, 0)

      tui.close()
      yield* Fiber.join(tui.fiber)
    }),
  ),
)

void test(
  "at 32×10 the result shows the whole reference and URL, clear of the scrollbar",
  scenario(
    Effect.gen(function* () {
      const plane = fakePlane({ me: me(active), createPaymentLink: createdLink() })
      const tui = yield* screen(plane, { width: 32, height: 10 })

      yield* tui.showing("press p to")
      tui.keys.pressKey("p")
      yield* tui.showing("Create payment link")
      yield* Effect.promise(() => tui.keys.typeText("Consulting"))
      tui.keys.pressTab()
      tui.keys.pressTab()
      tui.keys.pressTab()
      yield* Effect.promise(() => tui.keys.typeText("2500"))
      tui.keys.pressEnter()
      yield* tui.showing("Payment link created")

      for (let step = 0; step < 10; step++) {
        tui.keys.pressArrow("down")
      }

      const frame = yield* tui.showing("tui.test")

      // The scrolled rows' text, without borders or the scrollbar, joined up.
      const text = frame
        .split("\n")
        .map((row) => row.slice(2, -2).replace(/[▀▄█]/g, "").trimEnd())
        .join("")

      assert.ok(text.includes("plink_01K33YV8M82N9MXP4E7J6B1QWK"), text)
      assert.ok(text.includes("ssh tok@tui.test"), text)
      assert.match(frame, /\[Esc\] Back/)

      tui.close()
      yield* Fiber.join(tui.fiber)
    }),
  ),
)
