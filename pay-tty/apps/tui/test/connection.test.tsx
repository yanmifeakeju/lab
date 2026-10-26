// Drives a whole connection, keys in and frames out, through OpenTUI's test
// renderer: screens, session, and the generated client over a fake plane.
// Runs under Bun, which compiles the JSX.

import assert from "node:assert/strict"
import { test } from "node:test"

import { createTestRenderer } from "@opentui/core/testing"
import { Effect, Fiber } from "effect"
import stringWidth from "string-width"

import { connect } from "../src/connection.tsx"
import {
  active,
  business,
  createdLink,
  failure,
  fakePlane,
  first,
  inTurn,
  listed,
  merchantPayment,
  paymentDetail,
  paymentPage,
  me,
  overview,
  paid,
  type Reply,
  scenario,
  summary,
  tips,
} from "./support.ts"

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

        assert.deepEqual(paths(plane), ["POST /session", "GET /me", "POST /business/account"], code)

        tui.keys.pressEscape()

        const frame = yield* tui.matching((shown) => !shown.includes("Error") && shown.includes("Press o"))

        assert.doesNotMatch(frame, /Contact support/)
        assert.deepEqual(
          paths(plane),
          ["POST /session", "GET /me", "POST /business/account", "GET /me"],
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

const links = (plane: ReturnType<typeof fakePlane>) =>
  plane.calls.filter(({ method, path }) => method === "POST" && path === "/payment_links")

const listings = (plane: ReturnType<typeof fakePlane>) =>
  plane.calls.filter(({ method, path }) => method === "GET" && path === "/payment_links")

// From the business, through its links, to the link form.
const openForm = Effect.fnUntraced(function* (tui: Effect.Success<ReturnType<typeof screen>>) {
  yield* tui.showing("Payment links   l")
  tui.keys.pressKey("l")
  yield* tui.showing("Payment links ·")
  tui.keys.pressKey("n")
})

void test(
  "n on the links opens the form; a fixed link is created from the keyboard and shown, and Esc goes back",
  scenario(
    Effect.gen(function* () {
      const plane = fakePlane({ me: me(active), createPaymentLink: createdLink() })
      const tui = yield* screen(plane)

      yield* openForm(tui)

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
        { title: "Consulting", description: null, pricing: { mode: "fixed", amount: 250_000 } },
      ])

      tui.keys.pressEscape()
      yield* tui.showing("No payment links yet.")

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

      yield* openForm(tui)
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
          pricing: { mode: "customer_chooses", suggested_amount: 250_000, minimum_amount: null, maximum_amount: null },
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

      yield* openForm(tui)
      yield* tui.showing("Create payment link")
      yield* Effect.promise(() => tui.keys.typeText("Consulting"))
      tui.keys.pressEscape()
      yield* tui.showing("No payment links yet.")

      assert.equal(links(plane).length, 0)

      tui.close()
      yield* Fiber.join(tui.fiber)

      const unopened = fakePlane({ me: me(business()), createPaymentLink: createdLink() })
      const other = yield* screen(unopened)

      yield* other.showing("Payment links need it.")
      other.keys.pressKey("l")

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

      yield* openForm(tui)
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

      yield* openForm(tui)
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

      yield* openForm(tui)
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

        yield* openForm(tui)
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
          pricing: { mode: "customer_chooses", suggested_amount: 3_000, minimum_amount: 2_000, maximum_amount: 4_000 },
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

      yield* openForm(tui)
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

      yield* openForm(tui)
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
        { title: "Consulting", description: null, pricing: { mode: "fixed", amount: 2_500_000 } },
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

      yield* openForm(tui)
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
  "c on a link sends its pay command to the terminal's clipboard above the keys, and says when the terminal can't take it",
  scenario(
    Effect.gen(function* () {
      const plane = fakePlane({ me: me(active), createPaymentLink: createdLink() })
      const tui = yield* screen(plane)
      const sent: Array<string> = []
      let supported = true

      tui.setup.renderer.copyToClipboardOSC52 = (text) => {
        sent.push(text)

        return supported
      }

      yield* openForm(tui)
      yield* tui.showing("Create payment link")
      yield* Effect.promise(() => tui.keys.typeText("Consulting"))
      tui.keys.pressTab()
      tui.keys.pressTab()
      tui.keys.pressTab()
      yield* Effect.promise(() => tui.keys.typeText("2500"))
      tui.keys.pressEnter()
      yield* tui.showing("c copy command")

      tui.keys.pressKey("c")

      const notice = yield* tui.showing("Copied. If it doesn't paste, select the command and copy it.")

      assert.match(notice, /c copy command/)
      assert.deepEqual(sent, ["ssh tok@tui.test"])

      tui.keys.pressArrow("down")
      yield* tui.matching((frame) => !frame.includes("Copied."))

      supported = false
      tui.keys.pressKey("c")
      yield* tui.showing("This terminal can't copy; select the command")

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

      yield* openForm(tui)
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

// The row's text without the border or the scrollbar's column.
const rowsOf = (frame: string) => frame.split("\n").map((row) => row.replace(/^│ /, "").replace(/ *[▀▄█]? *│$/, ""))

void test(
  "l shows the links with their totals; Enter opens one with its payments, and Esc steps back a screen at a time",
  scenario(
    Effect.gen(function* () {
      const plane = fakePlane({ me: me(active), listPaymentLinks: listed(paid, tips) })
      const tui = yield* screen(plane)

      yield* tui.showing("Payment links   l")
      tui.keys.pressKey("l")

      const list = rowsOf(yield* tui.showing("Payment links · 2 links · 1 active"))

      assert.ok(list.includes("Collected ₦50,000.00 · 2 paid · 1 pending"))
      assert.ok(list.some((row) => /^› Logo design +₦25,000\.00 +2 paid +₦50,000\.00$/.test(row)), list.join("\n"))
      assert.ok(list.some((row) => /^ {2}Tips \(inactive\) +Customer chooses +0 paid +₦0\.00$/.test(row)))
      assert.ok(list.some((row) => row.startsWith("↑/↓ select · Enter open · n new")))

      tui.keys.pressEnter()

      const shown = rowsOf(yield* tui.showing("Collected: ₦50,000.00"))

      assert.ok(shown.includes("Payment link"))
      assert.ok(shown.includes("Logo design"))
      assert.ok(shown.includes("2 paid · 1 failed · 0 cancelled · 3 expired · 1 pending"))
      assert.ok(shown.includes("Last paid: 2026-10-19 14:02 UTC"))
      assert.ok(shown.includes("ssh tok@tui.test"))

      tui.keys.pressEscape()
      yield* tui.showing("› Logo design")
      tui.keys.pressArrow("down")
      yield* tui.showing("› Tips")
      tui.keys.pressEnter()
      yield* tui.showing("Inactive: it takes no new payments.")

      // Back to the list, still on the same link.
      tui.keys.pressEscape()
      yield* tui.showing("› Tips")
      tui.keys.pressEscape()
      yield* tui.showing("Payment links   l")

      // Opening the list asks plane once; stepping around it asks again only on p.
      assert.equal(listings(plane).length, 1)

      tui.keys.pressKey("l")
      yield* tui.showing("› Logo design")

      assert.equal(listings(plane).length, 2)

      tui.close()
      yield* Fiber.join(tui.fiber)
    }),
  ),
)

void test(
  "a link created from the list joins it once Esc reloads it",
  scenario(
    Effect.gen(function* () {
      const created = summary({ title: "Consulting", pricing: { mode: "fixed", amount: 250_000 } })

      const plane = fakePlane({
        me: me(active),
        createPaymentLink: createdLink(),
        listPaymentLinks: inTurn({ status: 200, body: overview() }, { status: 200, body: overview([created]) }),
      })

      const tui = yield* screen(plane)

      yield* openForm(tui)
      yield* tui.showing("Create payment link")
      yield* Effect.promise(() => tui.keys.typeText("Consulting"))
      tui.keys.pressTab()
      tui.keys.pressTab()
      tui.keys.pressTab()
      yield* Effect.promise(() => tui.keys.typeText("2500"))
      tui.keys.pressEnter()
      yield* tui.showing("Payment link created")
      tui.keys.pressEscape()

      const list = yield* tui.showing("› Consulting")

      assert.match(list, /Payment links · 1 link/)
      assert.equal(listings(plane).length, 2)

      tui.close()
      yield* Fiber.join(tui.fiber)
    }),
  ),
)

void test(
  "r refreshes the list; a failed load keeps it behind a popup that offers Retry",
  scenario(
    Effect.gen(function* () {
      const plane = fakePlane({
        me: me(active),
        listPaymentLinks: inTurn(
          { status: 200, body: overview([tips]) },
          "unreachable",
          { status: 200, body: overview([paid, tips]) },
        ),
      })

      const tui = yield* screen(plane)

      yield* tui.showing("Payment links   l")
      tui.keys.pressKey("l")
      yield* tui.showing("› Tips")
      tui.keys.pressKey("r")

      const popup = yield* tui.showing("Couldn't load your payment links.")

      assert.match(popup, /\[Enter\] Retry/)
      assert.match(popup, /Tips/)

      tui.keys.pressEnter()

      const list = yield* tui.matching((frame) => !frame.includes("Error") && frame.includes("2 links"))

      assert.match(list, /› Logo design/)
      assert.equal(listings(plane).length, 3)

      tui.close()
      yield* Fiber.join(tui.fiber)
    }),
  ),
)

void test(
  "at 32×10 a row keeps the title and what it collected, and the selection scrolls into view",
  scenario(
    Effect.gen(function* () {
      const many = Array.from({ length: 8 }, (_, at) =>
        summary({ id: `plink_${at}`, title: `Link ${at}`, stats: { ...paid.stats, collected: String((at + 1) * 100) } }))

      const plane = fakePlane({ me: me(active), listPaymentLinks: listed(...many) })

    const tui = yield* screen(plane, { width: 32, height: 10 })

      yield* tui.showing("Payment links   l")
      tui.keys.pressKey("l")

      const top = rowsOf(yield* tui.showing("› Link 0"))

      assert.ok(top.includes("Collected ₦36.00 · 16 paid"), top.join("\n"))
      assert.ok(top.some((row) => /^› Link 0 +₦1\.00$/.test(row)), top.join("\n"))
      assert.ok(top.some((row) => /^ {2}Link 2 +₦3\.00$/.test(row)), top.join("\n"))
      assert.ok(top.includes("↑/↓ · Enter · n · r · Esc"))

      for (let step = 0; step < 7; step++) {
        tui.keys.pressArrow("down")
      }

      const bottom = yield* tui.showing("› Link 7")

      assert.doesNotMatch(bottom, /Link 0/)

      tui.close()
      yield* Fiber.join(tui.fiber)
    }),
  ),
)

void test(
  "wide, emoji, and multi-line titles each draw on one row, with the amounts in the same columns as the rest",
  scenario(
    Effect.gen(function* () {
      const titled = (id: string, title: string) => summary({ ...paid, id, title })

      const plane = fakePlane({
        me: me(active),
        listPaymentLinks: listed(
          titled("plink_a", "Logo design"),
          titled("plink_b", "社区图书馆筹款活动：为孩子们购买新书和学习用品"),
          titled("plink_c", "Café 👩🏽‍💻 rentals 🇳🇬 weekly"),
          titled("plink_d", "Two\nlines"),
        ),
      })

      const tui = yield* screen(plane)

      yield* tui.showing("Payment links   l")
      tui.keys.pressKey("l")

      const frame = yield* tui.showing("Two lines")
      const rows = frame.split("\n").filter((row) => row.includes("₦50,000.00") && !row.includes("Collected"))

      assert.equal(rows.length, 4, frame)

      // Every row ends its amounts at the same column, inside the border.
      const ends = rows.map((row) => stringWidth(row.slice(0, row.lastIndexOf("₦50,000.00") + "₦50,000.00".length)))

      assert.equal(new Set(ends).size, 1, frame)
      assert.ok(rows.every((row) => stringWidth(row) === 70), frame)

      tui.close()
      yield* Fiber.join(tui.fiber)
    }),
  ),
)

void test("business menu arrows and p/l open the sections; link p preserves the origin and payments fit a narrow terminal", scenario(
  Effect.gen(function* () {
    const payment = merchantPayment()

    const plane = fakePlane({
      me: me(active),
      listPaymentLinks: listed(paid, tips),
      listPayments: () => ({ status: 200, body: paymentPage([payment]) }),
    })

    const tui = yield* screen(plane)

    yield* tui.showing("› Payments")
    tui.keys.pressArrow("down")
    yield* tui.showing("› Payment links")
    tui.keys.pressEnter()
    yield* tui.showing("Payment links ·")
    tui.keys.pressArrow("down")
    yield* tui.showing("› Tips")
    tui.keys.pressEnter()
    yield* tui.showing("Inactive:")
    tui.keys.pressKey("p")

    const filtered = yield* tui.showing("Payments · Tips")

    assert.ok(!filtered.includes("all links"))
    assert.equal(plane.calls.at(-1)?.query.get("link_id"), tips.id)

    tui.keys.pressEscape()
    yield* tui.showing("Inactive:")
    tui.keys.pressEscape()
    yield* tui.showing("› Tips")
    tui.keys.pressEscape()
    yield* tui.showing("Payment links   l")
    tui.keys.pressArrow("up")
    tui.keys.pressEnter()
    yield* tui.matching((frame) => rowsOf(frame).includes("Payments"))
    tui.keys.pressEnter()

    const detail = yield* tui.showing("Payment ID: pay_one")

    assert.match(detail, /Status: settled/)
    assert.match(detail, /Paid ₦25,000\.00 · 14:03/)
    assert.match(detail, /Settled · 14:03 · jrn_one/)
    assert.match(detail, /Link: Logo design/)
    assert.ok(!detail.includes("c copy"))
    assert.ok(!detail.includes("l link"))

    tui.keys.pressEscape()
    yield* tui.matching((frame) => rowsOf(frame).includes("Payments"))

    for (const width of [32, 53, 54, 55]) {
      tui.setup.resize(width, 10)

      const frame = yield* tui.matching((frame) => frame.includes("₦25,000.00") && frame.includes("Esc"))
      const rows = frame.split("\n").filter((row) => row !== "")

      assert.equal(rows.length, 10)
      assert.ok(rows.every((row) => stringWidth(row) === width))
      assert.match(frame, /₦25,000.00/)
      assert.match(frame, /Esc/)
    }

    tui.setup.resize(70, 20)
    tui.keys.pressEscape()
    yield* tui.showing("Payment links   l")
    tui.keys.pressKey("p")
    yield* tui.matching((frame) => rowsOf(frame).includes("Payments"))
    tui.keys.pressEscape()
    yield* tui.showing("Payment links   l")
    tui.keys.pressKey("l")
    yield* tui.showing("Payment links ·")

    tui.close()
    yield* Fiber.join(tui.fiber)
  }),
))

void test("payments load more, cycle filters, refresh and show empty states", scenario(
  Effect.gen(function* () {
    const plane = fakePlane({
      me: me(active),
      listPayments: inTurn(
        { status: 200, body: paymentPage([merchantPayment()], "next") },
        { status: 200, body: paymentPage([merchantPayment({ id: "pay_two", status: "failed" })]) },
        { status: 200, body: paymentPage([]) },
        { status: 200, body: paymentPage([]) },
        { status: 200, body: paymentPage([]) },
      ),
    })

    const tui = yield* screen(plane)

    yield* tui.showing("› Payments")
    tui.keys.pressKey("p")
    yield* tui.showing("Load more")
    tui.keys.pressArrow("down")
    yield* tui.showing("› Load more")
    tui.keys.pressEnter()

    const appended = yield* tui.showing("failed")

    assert.ok(!appended.includes("Load more"))
    assert.equal(plane.calls.at(-1)?.query.get("before"), "next")

    tui.keys.pressArrow("right")
    yield* tui.showing("No settled payments.")
    tui.keys.pressKey("r")
    yield* tui.showing("No settled payments.")

    assert.equal(plane.calls.at(-1)?.query.get("before"), null)

    tui.keys.pressArrow("left")
    yield* tui.showing("No payments yet.")

    tui.close()
    yield* Fiber.join(tui.fiber)
  }),
))


void test("the business menu fits at 32×10 and payment detail offers l for a link in the loaded overview", scenario(
  Effect.gen(function* () {
    const plane = fakePlane({
      me: me(opened), listPaymentLinks: listed(paid),
      listPayments: () => ({ status: 200, body: paymentPage([merchantPayment()]) }),
    })

    const tui = yield* screen(plane, { width: 32, height: 10 })

    const menu = yield* tui.showing("Payment links")

    assert.match(menu, /Payments/)
    assert.match(menu, /Ctrl\+C to quit/)

    tui.keys.pressKey("l")
    yield* tui.showing("Logo design")
    tui.keys.pressEnter()
    const linkDetail = yield* tui.showing("Esc · c copy · p payments")

    assert.ok(rowsOf(linkDetail).includes("Esc · c copy · p payments"))

    tui.keys.pressKey("p")
    yield* tui.showing("Payments · Logo design")
    tui.keys.pressEnter()
    tui.setup.resize(70, 20)

    const detail = yield* tui.showing("l link")

    assert.ok(!detail.includes("c copy"))

    tui.keys.pressKey("l")
    yield* tui.showing("Customers pay with:")

    tui.close()
    yield* Fiber.join(tui.fiber)
  }),
))


void test("wide payments show filter arrows and unswept expiry has an expired-at detail", scenario(
  Effect.gen(function* () {
    const expired = merchantPayment({ status: "expired", completed_at: null })

    const plane = fakePlane({
      me: me(active),
      listPayments: () => ({ status: 200, body: paymentPage([expired]) }),
      getPayment: () => ({ status: 200, body: paymentDetail(expired) }),
    })

    const tui = yield* screen(plane, { width: 100, height: 20 })

    yield* tui.showing("› Payments")
    tui.keys.pressKey("p")

    const list = yield* tui.showing("Attention →")

    assert.match(list, /← \[All\]/)

    tui.keys.pressEnter()

    const detail = yield* tui.showing("Expired at: 2026-10-22 14:32 UTC")

    assert.ok(!detail.includes("Expires at:"))

    tui.close()
    yield* Fiber.join(tui.fiber)
  }),
))
