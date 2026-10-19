// Drives a customer's connection, keys in and frames out: the screens, the
// pay session, and the generated client over a fake plane.

import assert from "node:assert/strict"
import { test } from "node:test"

import { createTestRenderer } from "@opentui/core/testing"
import { DateTime, Effect, Fiber } from "effect"

import { pay } from "../src/connection.tsx"
import { countdown } from "../src/pay-app.tsx"
import { payCommand } from "../src/pay-command.ts"
import {
  choosing,
  failure,
  fakePlane,
  first,
  payable,
  paymentOf,
  type Reply,
  scenario,
  shareToken,
  simulated,
  startedPayment,
} from "./support.ts"

const link = (shown = payable()) => (): Reply => ({ status: 200, body: shown })

const paths = (plane: ReturnType<typeof fakePlane>) => plane.calls.map(({ method, path }) => `${method} ${path}`)

const base = `/pay/payment_links/${shareToken}`

const screen = Effect.fnUntraced(function* (plane: ReturnType<typeof fakePlane>, size = { width: 70, height: 20 }) {
  const setup = yield* Effect.promise(() => createTestRenderer(size))
  const closers: Array<() => void> = []
  let ended = 0

  const fiber = yield* Effect.forkChild(
    pay(
      shareToken,
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

  const until = Effect.fnUntraced(function* (done: (frame: string) => boolean, what: string) {
    let frame = ""

    for (let attempt = 0; attempt < 300; attempt++) {
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
    endedTimes: (times: number) => until(() => ended === times, `ended ${times} times`),
    keys: setup.mockInput,
    finish: Effect.gen(function* () {
      closers.forEach((close) => close())
      yield* Fiber.join(fiber)
    }),
    frame: Effect.andThen(Effect.sleep("50 millis"), draw),
  }
})

void test(
  "a customer pays a fixed link: it loads by token alone, starts a pending payment, and succeeds",
  scenario(
    Effect.gen(function* () {
      const plane = fakePlane({ payableLink: link(), startPayment: startedPayment(), simulatePayment: simulated })
      const tui = yield* screen(plane)

      const shown = yield* tui.showing("▸ Pay ₦25,000.00")

      assert.match(shown, /Adaeze Studio/)
      assert.match(shown, /Logo design/)
      assert.match(shown, /Two concepts and one revision\./)

      tui.keys.pressEnter()

      const pending = yield* tui.showing("SIMULATED · no money moves")

      assert.match(pending, /Paying ₦25,000\.00/)
      assert.match(pending, /Expires in (30:00|29:5\d)/)
      assert.match(pending, /▸ Succeed/)

      tui.keys.pressEnter()

      const paid = yield* tui.showing("✓ Paid ₦25,000.00")

      assert.match(paid, /Reference pay_01K33YV8M82N9MXP4E7J6B1QWK/)
      assert.deepEqual(paths(plane), [`GET ${base}`, `POST ${base}/payments`, `POST ${base}/payments/pay_01K33YV8M82N9MXP4E7J6B1QWK/simulate`])

      // No merchant session, no bearer token; a key on the start, none sent for a fixed amount.
      assert.ok(plane.calls.every(({ authorization }) => authorization === null))
      assert.deepEqual(plane.calls[1]?.body, {})
      assert.match(plane.calls[1]?.idempotencyKey ?? "", /^[A-Za-z0-9_-]{22}$/)
      assert.deepEqual(plane.calls[2]?.body, { outcome: "succeeded" })

      tui.keys.pressEnter()
      yield* tui.endedTimes(1)
      yield* tui.finish
    }),
  ),
)

void test(
  "a failed payment offers another try, which starts a new payment under a new key",
  scenario(
    Effect.gen(function* () {
      const plane = fakePlane({ payableLink: link(), startPayment: startedPayment(), simulatePayment: simulated })
      const tui = yield* screen(plane)

      yield* tui.showing("▸ Pay")
      tui.keys.pressEnter()
      yield* tui.showing("▸ Succeed")
      tui.keys.pressArrow("down")
      yield* tui.showing("▸ Fail")
      tui.keys.pressEnter()
      yield* tui.showing("✗ Payment failed")
      yield* tui.showing("Enter try again")

      tui.keys.pressEnter()
      yield* tui.showing("▸ Pay ₦25,000.00")
      tui.keys.pressEnter()

      // A new pending payment starts on the first outcome again.
      yield* tui.showing("▸ Succeed")
      tui.keys.pressArrow("up")
      yield* tui.showing("▸ Cancel")
      tui.keys.pressEnter()
      yield* tui.showing("Payment cancelled")

      const keys = plane.calls.filter(({ path }) => path.endsWith("/payments")).map(({ idempotencyKey }) => idempotencyKey)

      assert.equal(keys.length, 2)
      assert.notEqual(keys[0], keys[1])
      assert.deepEqual(
        plane.calls.filter(({ path }) => path.endsWith("/simulate")).map(({ body }) => body),
        [{ outcome: "failed" }, { outcome: "cancelled" }],
      )

      yield* tui.finish
    }),
  ),
)

void test(
  "a customer-chosen amount starts at the suggestion, is checked against the bounds, and is sent in minor units",
  scenario(
    Effect.gen(function* () {
      const plane = fakePlane({
        payableLink: link(choosing({ suggested: 500_000, minimum: 100_000, maximum: 1_000_000 })),
        startPayment: startedPayment(),
      })

      const tui = yield* screen(plane)

      const shown = yield* tui.showing("Amount (NGN)")

      assert.match(shown, /5,000\.00/)
      assert.match(shown, /Suggested ₦5,000\.00 · Min ₦1,000\.00 · Max ₦10,000\.00/)

      tui.keys.pressEnter()
      yield* tui.showing("Paying ₦5,000.00")

      assert.deepEqual(plane.calls.at(-1)?.body, { amount_minor: 500_000 })

      yield* tui.finish
    }),
  ),
)

void test(
  "an amount outside the bounds or unreadable is refused on screen, and nothing is sent",
  scenario(
    Effect.gen(function* () {
      const plane = fakePlane({ payableLink: link(choosing({ minimum: 100_000, maximum: 1_000_000 })), startPayment: startedPayment() })
      const tui = yield* screen(plane)

      yield* tui.showing("Amount (NGN)")

      for (const [typed, message] of [
        ["", "Enter the amount to pay."],
        ["999", "The amount is below this link's minimum."],
        ["10000.01", "The amount is above this link's maximum."],
        ["12.345", "Use at most 2 decimal places."],
      ] as const) {
        yield* Effect.promise(() => tui.keys.typeText(typed))
        tui.keys.pressEnter()
        yield* tui.showing(message)
        tui.keys.pressEnter()
        yield* tui.showing("Enter pay")

        for (let index = 0; index < typed.length; index++) {
          tui.keys.pressBackspace()
        }
      }

      yield* Effect.promise(() => tui.keys.typeText("2,500.50"))
      tui.keys.pressEnter()
      yield* tui.showing("Paying ₦2,500.50")

      assert.deepEqual(paths(plane), [`GET ${base}`, `POST ${base}/payments`])
      assert.deepEqual(plane.calls[1]?.body, { amount_minor: 250_050 })

      yield* tui.finish
    }),
  ),
)

void test(
  "a deactivated link says so and starts nothing",
  scenario(
    Effect.gen(function* () {
      const plane = fakePlane({ payableLink: link(payable({ active: false })), startPayment: startedPayment() })
      const tui = yield* screen(plane)

      const shown = yield* tui.showing("This link is no longer accepting payments.")

      assert.doesNotMatch(shown, /▸ Pay/)

      tui.keys.pressEnter()
      yield* tui.frame

      assert.deepEqual(paths(plane), [`GET ${base}`])

      yield* tui.finish
    }),
  ),
)

void test(
  "a link deactivated after loading refuses the payment, and Close shows it inactive",
  scenario(
    Effect.gen(function* () {
      const plane = fakePlane({
        payableLink: first(link()())(link(payable({ active: false }))),
        startPayment: () => failure(409, "link_inactive"),
      })

      const tui = yield* screen(plane)

      yield* tui.showing("▸ Pay")
      tui.keys.pressEnter()
      yield* tui.showing("[Enter/Esc] Close")
      tui.keys.pressEnter()
      yield* tui.showing("This link is no longer accepting payments.")

      assert.deepEqual(paths(plane), [`GET ${base}`, `POST ${base}/payments`, `GET ${base}`])

      yield* tui.finish
    }),
  ),
)

void test(
  "an unknown token says so, and Enter ends the session",
  scenario(
    Effect.gen(function* () {
      const plane = fakePlane({ payableLink: () => failure(404, "not_found") })
      const tui = yield* screen(plane)

      yield* tui.showing("No payment link has this token.")
      tui.keys.pressEnter()
      yield* tui.endedTimes(1)
      yield* tui.finish
    }),
  ),
)

void test(
  "a failed start offers Retry, which reuses its key so it can't start a second payment",
  scenario(
    Effect.gen(function* () {
      const plane = fakePlane({ payableLink: link(), startPayment: first("unreachable")(startedPayment()) })
      const tui = yield* screen(plane)

      yield* tui.showing("▸ Pay")
      tui.keys.pressEnter()
      yield* tui.showing("Couldn't start the payment.")
      tui.keys.pressEnter()
      yield* tui.showing("SIMULATED · no money moves")

      const keys = plane.calls.filter(({ path }) => path.endsWith("/payments")).map(({ idempotencyKey }) => idempotencyKey)

      assert.equal(keys.length, 2)
      assert.equal(keys[0], keys[1])

      yield* tui.finish
    }),
  ),
)

void test(
  "a payment whose window passes on screen expires without asking plane",
  scenario(
    Effect.gen(function* () {
      const soon = DateTime.formatIso(DateTime.add(DateTime.nowUnsafe(), { seconds: 1 }))
      const plane = fakePlane({ payableLink: link(), startPayment: startedPayment({ expires_at: soon }) })
      const tui = yield* screen(plane)

      yield* tui.showing("▸ Pay")
      tui.keys.pressEnter()
      yield* tui.showing("SIMULATED · no money moves")
      yield* tui.showing("This payment expired")

      assert.deepEqual(paths(plane), [`GET ${base}`, `POST ${base}/payments`])

      // Another try starts afresh.
      tui.keys.pressEnter()
      yield* tui.showing("▸ Pay ₦25,000.00")
      yield* tui.finish
    }),
  ),
)

void test(
  "an outcome plane refuses as expired, or as already ended, is shown for what it is",
  scenario(
    Effect.gen(function* () {
      const plane = fakePlane({
        payableLink: link(),
        startPayment: startedPayment(),
        simulatePayment: first(failure(409, "payment_expired"))(() => failure(409, "not_pending")),
      })

      const tui = yield* screen(plane)

      yield* tui.showing("▸ Pay")
      tui.keys.pressEnter()
      yield* tui.showing("▸ Succeed")
      tui.keys.pressEnter()
      yield* tui.showing("This payment expired")

      tui.keys.pressEnter()
      yield* tui.showing("▸ Pay")
      tui.keys.pressEnter()
      yield* tui.showing("▸ Succeed")
      tui.keys.pressEnter()
      yield* tui.showing("This payment has already ended.")

      // Close reloads the link, ready for a new payment.
      tui.keys.pressEnter()
      yield* tui.showing("▸ Pay ₦25,000.00")

      yield* tui.finish
    }),
  ),
)

void test(
  "below the minimum size the screen asks for room, and the pending payment fits at 32×10",
  scenario(
    Effect.gen(function* () {
      const plane = fakePlane({ payableLink: link(), startPayment: startedPayment() })
      const tui = yield* screen(plane, { width: 31, height: 10 })

      yield* tui.showing("Enlarge the terminal to")

      tui.setup.resize(32, 10)
      yield* tui.showing("▸ Pay")
      tui.keys.pressEnter()

      const pending = yield* tui.showing("▸ Succeed")

      assert.match(pending, /Fail/)
      assert.match(pending, /Cancel/)
      assert.match(pending, /↑\/↓ · Enter · Esc/)

      yield* tui.finish
    }),
  ),
)

void test("the countdown shows minutes and seconds left, never below zero", () => {
  const expiresAt = "2026-10-19T12:30:00.000Z"
  const at = (iso: string) => Date.parse(iso)

  assert.equal(countdown(expiresAt, at("2026-10-19T12:00:00.000Z")), "30:00")
  assert.equal(countdown(expiresAt, at("2026-10-19T12:29:01.500Z")), "0:59")
  assert.equal(countdown(expiresAt, at("2026-10-19T12:31:00.000Z")), "0:00")
  assert.equal(paymentOf().status, "pending")
})

void test("the shared command names the port only when it isn't 22", () => {
  const token = "s".repeat(43)

  assert.equal(payCommand("pay.example", 22)(token), `ssh ${token}@pay.example`)
  assert.equal(payCommand("localhost", 2222)(token), `ssh -p 2222 ${token}@localhost`)
})
