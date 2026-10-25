import assert from "node:assert/strict"
import { test } from "node:test"

import { Effect, Result, SubscriptionRef } from "effect"
import stringWidth from "string-width"

import { formatMoney, Parsed, parseAmount } from "../src/money.ts"
import {
  emptyForm,
  type Form,
  formatTime,
  listHeading,
  listRow,
  narrowRow,
  pricingLines,
  statusLine,
  toRequest,
  totalsLine,
  withMode,
} from "../src/payment-link.ts"
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
  listed,
  me,
  overview,
  paid,
  summary,
  tips,
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

const links = (plane: ReturnType<typeof fakePlane>) =>
  plane.calls.filter(({ method, path }) => method === "POST" && path === "/payment_links")

const listings = (plane: ReturnType<typeof fakePlane>) =>
  plane.calls.filter(({ method, path }) => method === "GET" && path === "/payment_links")

const noLinks = overview()

// From the business's links, the link form.
const startLink = (session: Session.Interface) => Effect.andThen(session.manageLinks, session.startPaymentLink)

// Loaded with an active business and the link form open.
const onForm = <A>(next: (session: Session.Interface) => Effect.Effect<A>) => (session: Session.Interface) =>
  Effect.andThen(Effect.andThen(session.load, startLink(session)), next(session))

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
  assert.deepEqual(toRequest(fixed, 2, "NGN"), Result.succeed({
    title: "Consulting",
    description: null,
    pricing: { mode: "fixed", amount: 250_000 },
  }))

  assert.deepEqual(toRequest(donation, 2, "NGN"), Result.succeed({
    title: "Community fundraiser",
    description: "Help equip the library",
    pricing: { mode: "customer_chooses", suggested_amount: 250_000, minimum_amount: null, maximum_amount: null },
  }))

  // Every setting may be blank.
  assert.deepEqual(toRequest({ ...emptyForm, title: "Tips", mode: "customer_chooses" }, 2, "NGN"), Result.succeed({
    title: "Tips",
    description: null,
    pricing: { mode: "customer_chooses", suggested_amount: null, minimum_amount: null, maximum_amount: null },
  }))

  // Stale settings of the other mode never reach plane.
  assert.deepEqual(toRequest({ ...fixed, suggested: "1", minimum: "x" }, 2, "NGN"), toRequest(fixed, 2, "NGN"))
  assert.deepEqual(toRequest({ ...donation, amount: "9" }, 2, "NGN"), toRequest(donation, 2, "NGN"))

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
    [{ ...fixed, amount: "0.99" }, "Amount must be at least ₦1.00."],
    [{ ...donation, suggested: "0.99" }, "Suggested amount must be at least ₦1.00."],
    [{ ...donation, minimum: "0.99" }, "Minimum amount must be at least ₦1.00."],
    [{ ...donation, suggested: "", maximum: "0.99" }, "Maximum amount must be at least ₦1.00."],
  ]

  for (const [form, message] of refusals) {
    assert.deepEqual(toRequest(form, 2, "NGN"), Result.fail(message), message)
  }

  // One whole naira is the least, in either mode.
  assert.deepEqual(Result.map(toRequest({ ...fixed, amount: "1.00" }, 2, "NGN"), ({ pricing }) => pricing), Result.succeed({
    mode: "fixed",
    amount: 100,
  }))
  assert.deepEqual(
    Result.map(toRequest({ ...donation, suggested: "1", minimum: "1", maximum: "1" }, 2, "NGN"), ({ pricing }) => pricing),
    Result.succeed({ mode: "customer_chooses", suggested_amount: 100, minimum_amount: 100, maximum_amount: 100 }),
  )
})

void test("the result lists the pricing in the link's currency", () => {
  const request = Result.getOrThrow(toRequest({ ...donation, minimum: "1,000", maximum: "10000" }, 2, "NGN"))

  assert.deepEqual(pricingLines(linkFor(request)), [
    "Amount: Customer chooses · NGN",
    "Suggested: ₦2,500.00",
    "Minimum: ₦1,000.00",
    "Maximum: ₦10,000.00",
  ])
  assert.deepEqual(pricingLines(linkFor(Result.getOrThrow(toRequest(fixed, 2, "NGN")))), ["Amount: ₦2,500.00 · NGN"])
  assert.deepEqual(pricingLines(linkFor({ title: "Tips", pricing: { mode: "customer_chooses" } })), [
    "Amount: Customer chooses · NGN",
  ])
})

void test(
  "a fixed link is sent with an idempotency key and the created link is shown; Back returns to the links",
  scenario(
    Effect.gen(function* () {
      const plane = fakePlane({ me: me(active), createPaymentLink: createdLink() })

      yield* run(plane, onForm((session) =>
        Effect.gen(function* () {
          assert.deepEqual(yield* current(session), idle(View.CreatingLink({ business: active, overview: noLinks })))

          yield* session.createPaymentLink(fixed)

          const request = Result.getOrThrow(toRequest(fixed, 2, "NGN"))

          assert.deepEqual(yield* current(session), idle(View.LinkCreated({ business: active, overview: noLinks, link: linkFor(request) })))

          yield* session.back

          assert.deepEqual(yield* current(session), idle(View.Links({ business: active, overview: noLinks })))
        })
      ))

      const [call, ...rest] = links(plane)

      assert.equal(rest.length, 0)
      assert.deepEqual([call?.method, call?.path, call?.authorization], ["POST", "/payment_links", "Bearer tok_1"])
      assert.match(call?.idempotencyKey ?? "", /^[A-Za-z0-9_-]{22}$/)
      assert.deepEqual(call?.body, { title: "Consulting", description: null, pricing: { mode: "fixed", amount: 250_000 } })
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
        pricing: { mode: "customer_chooses", suggested_amount: null, minimum_amount: null, maximum_amount: null },
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

      assert.deepEqual(state, idle(View.Links({ business: active, overview: noLinks })))
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
            idle(View.CreatingLink({ business: active, overview: noLinks }), {
              message: "Amount: Use at most 2 decimal places.",
              retry: null,
              close: "dismiss",
            }),
          )

          yield* session.close

          assert.deepEqual(yield* current(session), idle(View.CreatingLink({ business: active, overview: noLinks })))
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
          yield* startLink(session)
          // Returning to the same submission, spelled differently.
          yield* session.createPaymentLink({ ...fixed, title: " Consulting ", amount: "2500.00" })

          assert.ok(View.$is("LinkCreated")((yield* current(session)).view))

          yield* session.back
          yield* startLink(session)
          yield* session.createPaymentLink(fixed)
          yield* session.back
          yield* startLink(session)
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

            assert.deepEqual(yield* current(session), idle(View.CreatingLink({ business: active, overview: noLinks }), popup), name)

            // Not a retry in disguise.
            yield* session.retry
            yield* session.close

            const after = yield* current(session)

            if (popup.close === "refresh") {
              assert.deepEqual(after, idle(View.HasBusiness({ business: active })), name)
              yield* startLink(session)
            } else {
              assert.deepEqual(after, idle(View.CreatingLink({ business: active, overview: noLinks })), name)
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

          assert.deepEqual(yield* current(session), idle(View.CreatingLink({ business: active, overview: noLinks })))
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

void test("the list's rows, heading, and totals read from plane's figures", () => {
  const list = overview([paid, tips])

  assert.equal(listHeading(list), "Payment links · 2 links · 1 active")
  assert.equal(listHeading(overview([paid])), "Payment links · 1 link")
  assert.equal(totalsLine(list.totals, 2, "NGN"), "Collected ₦50,000.00 · 2 paid · 1 pending")
  assert.equal(statusLine(paid.stats), "2 paid · 1 failed · 0 cancelled · 3 expired · 1 pending")
  assert.equal(formatTime("2026-10-19T14:02:31.000Z"), "2026-10-19 14:02 UTC")

  // A sum past the safe integers keeps every digit.
  assert.equal(formatMoney(9_007_199_254_740_993n, 2, "NGN"), "₦90,071,992,547,409.93")

  const wide = listRow(paid, 60)

  assert.equal(wide.length, 60)
  assert.match(wide, /^Logo design +₦25,000\.00 +2 paid +₦50,000\.00$/)
  assert.match(listRow(tips, 60), /^Tips \(inactive\) +Customer chooses +0 paid +₦0\.00$/)

  // Narrow rows keep the title and what it collected, cutting the title short.
  assert.match(listRow(paid, narrowRow - 1), /^Logo design +₦50,000\.00$/)
  assert.equal(listRow(summary({ ...paid, title: "A very long link title indeed" }), 30), "A very long link t… ₦50,000.00")
})

void test("rows measure titles in terminal columns and keep them to one line", () => {
  const chinese = summary({ ...paid, title: "社区图书馆筹款活动：为孩子们购买新书和学习用品" })

  for (const width of [62, 61, 30, 29]) {
    const row = listRow(chinese, width)

    assert.equal(stringWidth(row), width, `${width}: ${row}`)
    assert.match(row, /₦50,000\.00$/, `${width}: ${row}`)
  }

  // Nine characters and the ellipsis fill 19 columns; in 18, a wide character
  // won't fit before the ellipsis, so a column of space is left.
  assert.ok(listRow(chinese, 62).startsWith("社区图书馆筹款活动… "))
  assert.ok(listRow(chinese, 61).startsWith("社区图书馆筹款活…  "))
  assert.equal(listRow(chinese, 30), "社区图书馆筹款活动… ₦50,000.00")

  // Emoji and combining marks are cut between graphemes, never inside one.
  const mixed = listRow(summary({ ...paid, title: "Café 👩🏽‍💻 rentals 🇳🇬 weekly 🎉🎉🎉" }), 30)

  assert.equal(stringWidth(mixed), 30)
  assert.ok(!mixed.includes("\uFFFD"))

  // Breaks, tabs, and other control characters collapse into single spaces.
  const broken = listRow(summary({ ...paid, title: " Logo\ndesign\r\n\tand\u0007 more " }), 70)

  assert.doesNotMatch(broken, /\p{Cc}/u)
  assert.match(broken, /^Logo design and more +₦25,000\.00 +2 paid +₦50,000\.00$/)
  assert.equal(stringWidth(broken), 70)

  // A cut never leaves a space before the ellipsis.
  assert.ok(listRow(summary({ ...paid, title: "Logo design and more" }), 60).startsWith("Logo design and…  "))
})

void test(
  "p loads the links; a link opens from the list and Back steps out one screen at a time",
  scenario(
    Effect.gen(function* () {
      const plane = fakePlane({ me: me(active), listPaymentLinks: listed(paid, tips) })
      const list = overview([paid, tips])

      yield* run(plane, (session) =>
        Effect.gen(function* () {
          yield* session.load
          yield* session.manageLinks

          assert.deepEqual(yield* current(session), idle(View.Links({ business: active, overview: list })))

          // Not a listed link: nothing changes.
          yield* session.openLink("plink_other")
          yield* session.openLink("plink_tips")

          assert.deepEqual(
            yield* current(session),
            idle(View.LinkDetail({ business: active, overview: list, link: tips })),
          )

          yield* session.back

          assert.deepEqual(yield* current(session), idle(View.Links({ business: active, overview: list })))

          yield* session.back

          assert.deepEqual(yield* current(session), idle(View.HasBusiness({ business: active })))
        })
      )

      assert.equal(listings(plane).length, 1)
      assert.equal(listings(plane)[0]?.authorization, "Bearer tok_1")
    }),
  ),
)

void test(
  "a business without an open account has no links to manage",
  scenario(
    Effect.gen(function* () {
      const plane = fakePlane({ me: me(business()) })

      const state = yield* run(plane, (session) =>
        Effect.andThen(Effect.andThen(session.load, startLink(session)), current(session)))

      assert.deepEqual(state, idle(View.HasBusiness({ business: business() })))
      assert.equal(listings(plane).length, 0)
    }),
  ),
)

void test(
  "refresh reloads the list; a failed load keeps the screen behind and offers Retry",
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

      yield* run(plane, (session) =>
        Effect.gen(function* () {
          yield* session.load
          yield* session.manageLinks
          yield* session.refreshLinks

          const before = View.Links({ business: active, overview: overview([tips]) })

          assert.deepEqual(
            yield* current(session),
            idle(before, {
              message: "Couldn't load your payment links.",
              retry: Operation.ListLinks({ business: active }),
              close: "dismiss",
            }),
          )

          yield* session.retry

          assert.deepEqual(
            yield* current(session),
            idle(View.Links({ business: active, overview: overview([paid, tips]) })),
          )
        })
      )

      assert.equal(listings(plane).length, 3)
    }),
  ),
)

void test(
  "a business plane no longer finds is reloaded on Close",
  scenario(
    Effect.gen(function* () {
      const plane = fakePlane({ me: me(active), listPaymentLinks: first(failure(409, "business_required"))(listed()) })

      yield* run(plane, (session) =>
        Effect.gen(function* () {
          yield* session.load
          yield* session.manageLinks

          assert.deepEqual(
            yield* current(session),
            idle(View.HasBusiness({ business: active }), {
              message: "Create a business first.",
              retry: null,
              close: "refresh",
            }),
          )

          yield* session.close

          assert.deepEqual(yield* current(session), idle(View.HasBusiness({ business: active })))
        })
      )

      assert.equal(plane.calls.filter(({ path }) => path === "/me").length, 2)
    }),
  ),
)
