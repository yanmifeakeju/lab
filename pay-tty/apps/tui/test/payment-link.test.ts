import assert from "node:assert/strict"
import { test } from "node:test"

import { Effect, Result, SubscriptionRef } from "effect"

import { formatMoney, Parsed, parseAmount } from "../src/money.ts"
import { emptyForm, type Form, pricingLines, toRequest, withMode } from "../src/payment-link.ts"
import { Operation, type Popup, Session, type State, View } from "../src/session.ts"
import {
  active,
  business,
  createdLink,
  failure,
  fakePlane,
  first,
  inTurn,
  linkFor,
  me,
  type Reply,
  scenario,
  unauthorized,
} from "./support.ts"

const run = <A>(plane: ReturnType<typeof fakePlane>, body: (session: Session.Interface) => Effect.Effect<A>) =>
  Effect.flatMap(Session.make("SHA256:key").pipe(Effect.provide(plane.layer)), body)

const current = (session: Session.Interface) => SubscriptionRef.get(session.state)

const idle = (view: View, popup: Popup | null = null): State => ({ view, pending: false, popup })

const fixed: Form = { ...emptyForm, title: "Consulting", amount: "2,500" }

const donation: Form = {
  ...emptyForm,
  title: " Community fundraiser ",
  description: "Help equip the library",
  mode: "customer_chooses",
  suggested: "2500.00",
}

const links = (plane: ReturnType<typeof fakePlane>) => plane.calls.filter(({ path }) => path.endsWith("/payment_links"))

// Loaded with an active business and the link form open.
const onForm = <A>(next: (session: Session.Interface) => Effect.Effect<A>) => (session: Session.Interface) =>
  Effect.andThen(Effect.andThen(session.load, session.startPaymentLink), next(session))

const refused: Reply = {
  status: 400,
  body: {
    message: "Request validation failed.",
    error: {
      code: "validation_error",
      details: [{ location: "body", field: "title", code: "max_length", message: "too long" }],
    },
  },
}

void test("amounts parse at the scale with integer arithmetic alone", () => {
  const amounts: ReadonlyArray<readonly [string, number, number]> = [
    ["2500", 2, 250_000],
    ["2,500.00", 2, 250_000],
    [" 2500.5 ", 2, 250_050],
    ["0.01", 2, 1],
    ["0.10", 2, 10],
    ["1,234,567.89", 2, 123_456_789],
    ["25", 0, 25],
    ["1.005", 3, 1_005],
    ["90071992547409.91", 2, Number.MAX_SAFE_INTEGER],
  ]

  for (const [text, scale, minor] of amounts) {
    assert.deepEqual(parseAmount(text, scale), Parsed.Amount({ minor }), text)
  }

  assert.deepEqual(parseAmount("   ", 2), Parsed.Blank())

  const invalid: ReadonlyArray<readonly [string, number]> = [
    ["abc", 2], ["-5", 2], ["1e5", 2], ["1.2.3", 2], ["2,50", 2], [".5", 2], ["5.", 2], ["₦5", 2],
    ["0", 2], ["0.00", 2], ["1.234", 2], ["2.5", 0], ["90071992547409.92", 2],
  ]

  for (const [text, scale] of invalid) {
    assert.ok(Parsed.$is("Invalid")(parseAmount(text, scale)), text)
  }

  assert.equal(formatMoney(250_000, 2, "NGN"), "₦2,500.00")
  assert.equal(formatMoney(1, 2, "NGN"), "₦0.01")
  assert.equal(formatMoney(Number.MAX_SAFE_INTEGER, 2, "USD"), "$90,071,992,547,409.91")
  assert.equal(formatMoney(5, 0, "XOF"), "XOF 5")
})

void test("the form becomes plane's request, reading only the chosen mode's settings", () => {
  assert.deepEqual(toRequest(fixed, 2), Result.succeed({
    title: "Consulting",
    description: null,
    pricing: { mode: "fixed", amount_minor: 250_000 },
  }))

  assert.deepEqual(toRequest(donation, 2), Result.succeed({
    title: "Community fundraiser",
    description: "Help equip the library",
    pricing: { mode: "customer_chooses", suggested_amount_minor: 250_000, minimum_amount_minor: null, maximum_amount_minor: null },
  }))

  // Every setting may be blank.
  assert.deepEqual(toRequest({ ...emptyForm, title: "Tips", mode: "customer_chooses" }, 2), Result.succeed({
    title: "Tips",
    description: null,
    pricing: { mode: "customer_chooses", suggested_amount_minor: null, minimum_amount_minor: null, maximum_amount_minor: null },
  }))

  // Stale settings of the other mode never reach plane.
  assert.deepEqual(toRequest({ ...fixed, suggested: "1", minimum: "x" }, 2), toRequest(fixed, 2))
  assert.deepEqual(toRequest({ ...donation, amount: "9" }, 2), toRequest(donation, 2))

  // Switching mode clears them, keeping the title and description.
  assert.deepEqual(withMode(fixed, "customer_chooses"), { ...emptyForm, title: "Consulting", mode: "customer_chooses" })
  assert.deepEqual(withMode(withMode(donation, "fixed"), "customer_chooses"), { ...emptyForm, title: donation.title, description: donation.description, mode: "customer_chooses" })
  assert.equal(withMode(fixed, "fixed"), fixed)

  const refusals: ReadonlyArray<readonly [Form, string]> = [
    [{ ...fixed, title: "  " }, "Enter a title."],
    [{ ...fixed, title: "x".repeat(256) }, "Use a title of at most 255 characters."],
    [{ ...fixed, description: "x".repeat(501) }, "Use a description of at most 500 characters."],
    [{ ...fixed, amount: "" }, "Enter the amount."],
    [{ ...fixed, amount: "0" }, "Amount: Enter an amount greater than zero."],
    [{ ...fixed, amount: "2.555" }, "Amount: Use at most 2 decimal places."],
    [{ ...donation, minimum: "abc" }, "Minimum amount: Enter an amount like 2,500.00."],
    [{ ...donation, suggested: "", minimum: "20", maximum: "10" }, "The maximum must be at least the minimum."],
    [{ ...donation, minimum: "3000" }, "The suggested amount must be within the minimum and maximum."],
    [{ ...donation, maximum: "2000" }, "The suggested amount must be within the minimum and maximum."],
  ]

  for (const [form, message] of refusals) {
    assert.deepEqual(toRequest(form, 2), Result.fail(message), message)
  }
})

void test("the result lists the pricing in the link's currency", () => {
  const request = Result.getOrThrow(toRequest({ ...donation, minimum: "1,000", maximum: "10000" }, 2))

  assert.deepEqual(pricingLines(linkFor(request)), [
    "Amount: Customer chooses · NGN",
    "Suggested: ₦2,500.00",
    "Minimum: ₦1,000.00",
    "Maximum: ₦10,000.00",
  ])
  assert.deepEqual(pricingLines(linkFor(Result.getOrThrow(toRequest(fixed, 2)))), ["Amount: ₦2,500.00 · NGN"])
  assert.deepEqual(pricingLines(linkFor({ title: "Tips", pricing: { mode: "customer_chooses" } })), [
    "Amount: Customer chooses · NGN",
  ])
})

void test(
  "a fixed link is sent with an idempotency key and the created link is shown; Back returns to the business",
  scenario(
    Effect.gen(function* () {
      const plane = fakePlane({ me: me(active), createPaymentLink: createdLink() })

      yield* run(plane, onForm((session) =>
        Effect.gen(function* () {
          assert.deepEqual(yield* current(session), idle(View.CreatingLink({ business: active })))

          yield* session.createPaymentLink(fixed)

          const request = Result.getOrThrow(toRequest(fixed, 2))

          assert.deepEqual(yield* current(session), idle(View.LinkCreated({ business: active, link: linkFor(request) })))

          yield* session.back

          assert.deepEqual(yield* current(session), idle(View.HasBusiness({ business: active })))
        })
      ))

      const [call, ...rest] = links(plane)

      assert.equal(rest.length, 0)
      assert.deepEqual([call?.method, call?.path, call?.authorization], ["POST", "/payment_links", "Bearer tok_1"])
      assert.match(call?.idempotencyKey ?? "", /^[A-Za-z0-9_-]{22}$/)
      assert.deepEqual(call?.body, { title: "Consulting", description: null, pricing: { mode: "fixed", amount_minor: 250_000 } })
    }),
  ),
)

void test(
  "an open-amount link sends every setting as null",
  scenario(
    Effect.gen(function* () {
      const plane = fakePlane({ me: me(active), createPaymentLink: createdLink() })

      const state = yield* run(plane, onForm((session) =>
        Effect.andThen(session.createPaymentLink({ ...emptyForm, title: "Tips", mode: "customer_chooses" }), current(session))
      ))

      assert.ok(View.$is("LinkCreated")(state.view))
      assert.deepEqual(links(plane)[0]?.body, {
        title: "Tips",
        description: null,
        pricing: { mode: "customer_chooses", suggested_amount_minor: null, minimum_amount_minor: null, maximum_amount_minor: null },
      })
    }),
  ),
)

void test(
  "the form opens only for a business whose account is open, and Back before submitting creates nothing",
  scenario(
    Effect.gen(function* () {
      const unopened = fakePlane({ me: me(business()), createPaymentLink: createdLink() })

      const shown = yield* run(unopened, onForm((session) => current(session)))

      assert.deepEqual(shown, idle(View.HasBusiness({ business: business() })))

      const plane = fakePlane({ me: me(active), createPaymentLink: createdLink() })

      const state = yield* run(plane, onForm((session) => Effect.andThen(session.back, current(session))))

      assert.deepEqual(state, idle(View.HasBusiness({ business: active })))
      assert.equal(links(plane).length + links(unopened).length, 0)
    }),
  ),
)

void test(
  "a form plane would refuse is explained without asking it, and Close returns to the form",
  scenario(
    Effect.gen(function* () {
      const plane = fakePlane({ me: me(active), createPaymentLink: createdLink() })

      yield* run(plane, onForm((session) =>
        Effect.gen(function* () {
          yield* session.createPaymentLink({ ...fixed, amount: "2.555" })

          assert.deepEqual(
            yield* current(session),
            idle(View.CreatingLink({ business: active }), {
              message: "Amount: Use at most 2 decimal places.",
              retry: null,
              close: "dismiss",
            }),
          )

          yield* session.close

          assert.deepEqual(yield* current(session), idle(View.CreatingLink({ business: active })))
        })
      ))

      assert.equal(links(plane).length, 0)
    }),
  ),
)

void test(
  "Retry resends the captured request under its key, even across a token renewal",
  scenario(
    Effect.gen(function* () {
      const plane = fakePlane({
        me: me(active),
        createPaymentLink: first("unreachable", { status: 500, body: {} }, unauthorized)(createdLink()),
      })

      yield* run(plane, onForm((session) =>
        Effect.gen(function* () {
          yield* session.createPaymentLink(fixed)

          const popup = (yield* current(session)).popup

          assert.equal(popup?.message, "Couldn't create the payment link.")
          assert.equal(popup.close, "dismiss")
          assert.ok(popup.retry !== null && Operation.$is("CreatePaymentLink")(popup.retry))

          yield* session.retry

          assert.equal((yield* current(session)).popup?.message, "Couldn't create the payment link.")

          // The 401 renews the token; the retry after it keeps the key.
          yield* session.retry

          assert.ok(View.$is("LinkCreated")((yield* current(session)).view))
        })
      ))

      const sent = links(plane)

      assert.equal(sent.length, 4)
      assert.equal(new Set(sent.map(({ idempotencyKey }) => idempotencyKey)).size, 1)
      assert.equal(new Set(sent.map(({ body }) => JSON.stringify(body))).size, 1)
      assert.deepEqual(sent.map(({ authorization }) => authorization), ["Bearer tok_1", "Bearer tok_1", "Bearer tok_1", "Bearer tok_2"])
    }),
  ),
)

void test(
  "after a lost answer, resubmitting the same form reuses its key; an edited form or a new link gets a new one",
  scenario(
    Effect.gen(function* () {
      const plane = fakePlane({
        me: me(active),
        createPaymentLink: (call) =>
          links(plane).length <= 1 ? "unreachable" : createdLink(links(plane).length === 2 ? 200 : 201)(call),
      })

      yield* run(plane, onForm((session) =>
        Effect.gen(function* () {
          yield* session.createPaymentLink(fixed)
          yield* session.close
          yield* session.back
          yield* session.startPaymentLink
          // Returning to the same submission, spelled differently.
          yield* session.createPaymentLink({ ...fixed, title: " Consulting ", amount: "2500.00" })

          assert.ok(View.$is("LinkCreated")((yield* current(session)).view))

          yield* session.back
          yield* session.startPaymentLink
          yield* session.createPaymentLink(fixed)
          yield* session.back
          yield* session.startPaymentLink
          yield* session.createPaymentLink({ ...fixed, amount: "2600" })
        })
      ))

      const keys = links(plane).map(({ idempotencyKey }) => idempotencyKey)

      assert.equal(keys.length, 4)
      assert.equal(keys[1], keys[0])
      assert.equal(new Set(keys).size, 3)
    }),
  ),
)

void test(
  "plane's refusals are Close-only and settle the submission; a missing business reloads on Close",
  scenario(
    Effect.gen(function* () {
      const cases: ReadonlyArray<readonly [string, Reply, Popup]> = [
        [
          "conflict",
          failure(409, "conflict"),
          {
            message: "That request was already used for a different link, so no link was created. Submit again to create one.",
            retry: null,
            close: "dismiss",
          },
        ],
        [
          "validation",
          refused,
          { message: "Plane refused the link's details. Check them and try again.", retry: null, close: "dismiss" },
        ],
        ["no business", failure(409, "business_required"), { message: "Create a business first.", retry: null, close: "refresh" }],
      ]

      for (const [name, reply, popup] of cases) {
        const plane = fakePlane({ me: me(active), createPaymentLink: first(reply)(createdLink()) })

        yield* run(plane, onForm((session) =>
          Effect.gen(function* () {
            yield* session.createPaymentLink(fixed)

            assert.deepEqual(yield* current(session), idle(View.CreatingLink({ business: active }), popup), name)

            // Not a retry in disguise.
            yield* session.retry
            yield* session.close

            const after = yield* current(session)

            if (popup.close === "refresh") {
              assert.deepEqual(after, idle(View.HasBusiness({ business: active })), name)
              yield* session.startPaymentLink
            } else {
              assert.deepEqual(after, idle(View.CreatingLink({ business: active })), name)
            }

            yield* session.createPaymentLink(fixed)
          })
        ))

        const keys = links(plane).map(({ idempotencyKey }) => idempotencyKey)

        assert.equal(keys.length, 2, name)
        assert.notEqual(keys[0], keys[1], name)
        assert.equal(plane.calls.filter(({ path }) => path === "/me").length, popup.close === "refresh" ? 2 : 1, name)
      }
    }),
  ),
)

void test(
  "a second submit while one is in flight sends nothing",
  scenario(
    Effect.gen(function* () {
      const plane = fakePlane({ me: me(active), createPaymentLink: createdLink() })

      yield* run(plane, onForm((session) =>
        Effect.gen(function* () {
          yield* SubscriptionRef.update(session.state, (state) => ({ ...state, pending: true }))
          yield* session.createPaymentLink(fixed)
          yield* session.back
          yield* SubscriptionRef.update(session.state, (state) => ({ ...state, pending: false }))

          assert.deepEqual(yield* current(session), idle(View.CreatingLink({ business: active })))
        })
      ))

      assert.equal(links(plane).length, 0)
    }),
  ),
)

void test(
  "connections keep their own keys and screens",
  scenario(
    Effect.gen(function* () {
      const plane = fakePlane({ me: me(active), createPaymentLink: inTurn("unreachable") })

      const first = yield* Session.make("SHA256:one").pipe(Effect.provide(plane.layer))
      const second = yield* Session.make("SHA256:two").pipe(Effect.provide(plane.layer))

      yield* onForm((session) => session.createPaymentLink(fixed))(first)
      yield* onForm((session) => session.createPaymentLink(fixed))(second)

      const keys = links(plane).map(({ idempotencyKey }) => idempotencyKey)

      assert.equal(keys.length, 2)
      assert.notEqual(keys[0], keys[1])

      yield* first.close

      assert.equal((yield* current(first)).popup, null)
      assert.notEqual((yield* current(second)).popup, null)
    }),
  ),
)
