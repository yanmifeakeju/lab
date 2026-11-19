import assert from "node:assert/strict"
import { test } from "node:test"

import { Deferred, Duration, Effect, Result, SubscriptionRef } from "effect"

import { detailLines, formOf, statusLine, toSettingsRequest } from "../src/payouts.ts"
import { Balance, Operation, type Popup, Session, SettingsOrigin, type State, View } from "../src/session.ts"
import { merchantPayment, paymentPage, paid, tips, listed, active, business, failure, fakePlane, figures, first, home, inTurn, me, meetup, movement, overview, banks, gtbank, payout, payoutSettings, type Reply, scenario, sessions, settled, statement, unauthorized } from "./support.ts"

// The session over the fake; its methods keep the client they were made
// with, so they run without it.
const run = <A, R>(plane: ReturnType<typeof fakePlane>, body: (session: Session.Interface) => Effect.Effect<A, never, R>) =>
  Effect.flatMap(Session.make("SHA256:key").pipe(Effect.provide(plane.layer)), body)

// As `run`, reading a moving payout's screen again every `every`.
const runFollowing = <A, R>(
  plane: ReturnType<typeof fakePlane>,
  every: Duration.Duration,
  body: (session: Session.Interface) => Effect.Effect<A, never, R>,
) => Effect.flatMap(Session.make("SHA256:key", { followEvery: every }).pipe(Effect.provide(plane.layer)), body)

// As `runFollowing`, with the follow's backoff and quiet limit short too.
const runQuieting = <A, R>(
  plane: ReturnType<typeof fakePlane>,
  body: (session: Session.Interface) => Effect.Effect<A, never, R>,
) =>
  Effect.flatMap(
    Session.make("SHA256:key", {
      followEvery: Duration.millis(10),
      followBackoff: Duration.millis(20),
      followQuiet: Duration.millis(100),
    }).pipe(Effect.provide(plane.layer)),
    body,
  )

// Once any balance home is loading has answered.
const current = settled

const loadThen = <A>(next: (session: Session.Interface) => Effect.Effect<A>) => (session: Session.Interface) =>
  Effect.andThen(session.load, Effect.andThen(next(session), current(session)))

const idle = (view: View, popup: Popup | null = null): State => ({ view, pending: false, popup })

const loadFailed = idle(View.Unknown(), { message: "Couldn't load your account.", retry: Operation.Load(), close: null })

const paths = (plane: ReturnType<typeof fakePlane>) => plane.calls.map(({ method, path }) => `${method} ${path}`)

void test(
  "a key with no business exchanges its fingerprint, loads /me, and shows the form",
  scenario(
    Effect.gen(function* () {
      const plane = fakePlane({ me: me(null) })

      const state = yield* run(plane, loadThen(() => Effect.void))

      assert.deepEqual(state, idle(View.NoBusiness()))
      assert.deepEqual(
        plane.calls.map(({ method, path, authorization, body }) => [method, path, authorization, body]),
        [
          ["POST", "/session", null, { issuer: "ssh", sub: "SHA256:key" }],
          ["GET", "/me", "Bearer tok_1", null],
        ],
      )
    }),
  ),
)

void test(
  "a key with a business shows it",
  scenario(
    Effect.gen(function* () {
      const state = yield* run(fakePlane({ me: me(active) }), loadThen(() => Effect.void))

      assert.deepEqual(state, idle(home(active, 1)))
    }),
  ),
)

void test(
  "a failed load leaves the business unknown with Retry alone, and Retry recovers",
  scenario(
    Effect.gen(function* () {
      const plane = fakePlane({ me: inTurn("unreachable", { status: 500, body: {} }, me(null)()) })

      yield* run(plane, (session) =>
        Effect.gen(function* () {
          yield* session.load

          assert.deepEqual(yield* current(session), loadFailed, "unreachable")

          // Nothing to close to.
          yield* session.close

          assert.deepEqual(yield* current(session), loadFailed)

          yield* session.retry

          assert.deepEqual(yield* current(session), loadFailed, "500")

          yield* session.retry

          assert.deepEqual(yield* current(session), idle(View.NoBusiness()))
        }),
      )

      assert.deepEqual(paths(plane), ["POST /session", "GET /me", "GET /me", "GET /me"])
    }),
  ),
)

void test(
  "a refused exchange is a failed load",
  scenario(
    Effect.gen(function* () {
      const plane = fakePlane({ session: () => failure(403, "forbidden") })

      assert.deepEqual(yield* run(plane, loadThen(() => Effect.void)), loadFailed)
      assert.deepEqual(paths(plane), ["POST /session"])
    }),
  ),
)

void test(
  "a token is reused until it nears expiry, then exchanged again",
  scenario(
    Effect.gen(function* () {
      const lasting = fakePlane({ me: inTurn("unreachable", me(null)()) })

      yield* run(lasting, (session) => Effect.andThen(session.load, session.retry))

      assert.deepEqual(lasting.calls.map(({ path, authorization }) => [path, authorization]), [
        ["/session", null],
        ["/me", "Bearer tok_1"],
        ["/me", "Bearer tok_1"],
      ])

      // Inside the renewal margin from the start, so every request renews.
      const expiring = fakePlane({ session: sessions(30), me: inTurn("unreachable", me(null)()) })

      yield* run(expiring, (session) => Effect.andThen(session.load, session.retry))

      assert.deepEqual(expiring.calls.map(({ path, authorization }) => [path, authorization]), [
        ["/session", null],
        ["/me", "Bearer tok_1"],
        ["/session", null],
        ["/me", "Bearer tok_2"],
      ])
    }),
  ),
)

void test(
  "a 401 exchanges once more and retries; a second 401 fails the load",
  scenario(
    Effect.gen(function* () {
      const recovering = fakePlane({
        me: (call) => (call.authorization === "Bearer tok_1" ? unauthorized : me(null)()),
      })

      assert.deepEqual(yield* run(recovering, loadThen(() => Effect.void)), idle(View.NoBusiness()))
      assert.deepEqual(recovering.calls.map(({ path, authorization }) => [path, authorization]), [
        ["/session", null],
        ["/me", "Bearer tok_1"],
        ["/session", null],
        ["/me", "Bearer tok_2"],
      ])

      const refused = fakePlane({ me: () => unauthorized })

      assert.deepEqual(yield* run(refused, loadThen(() => Effect.void)), loadFailed)
      assert.equal(refused.calls.length, 4)
    }),
  ),
)

void test(
  "creating a business sends the trimmed name in Nigeria and shows what plane returned",
  scenario(
    Effect.gen(function* () {
      const plane = fakePlane({ me: me(null), createBusiness: () => ({ status: 200, body: business() }) })

      const state = yield* run(plane, loadThen((session) => session.createBusiness("  Acme Ltd \t")))

      assert.deepEqual(state, idle(home(business())))
      assert.deepEqual(plane.calls.at(-1)?.body, { name: "Acme Ltd", country_code: "NG" })
    }),
  ),
)

void test(
  "a blank name is refused without asking plane, and Close just dismisses it",
  scenario(
    Effect.gen(function* () {
      const plane = fakePlane({ me: me(null) })

      yield* run(plane, (session) =>
        Effect.gen(function* () {
          yield* session.load
          yield* session.createBusiness(" \t ")

          assert.deepEqual(
            yield* current(session),
            idle(View.NoBusiness(), { message: "Enter a business name.", retry: null, close: "dismiss" }),
          )

          yield* session.close

          assert.deepEqual(yield* current(session), idle(View.NoBusiness()))
        }),
      )

      assert.deepEqual(paths(plane), ["POST /session", "GET /me"])
    }),
  ),
)

void test(
  "plane's refusals of a create are Close-only; anything else offers Retry",
  scenario(
    Effect.gen(function* () {
      const tooLong: Reply = {
        status: 400,
        body: {
          message: "Request validation failed.",
          error: {
            code: "validation_error",
            details: [{ location: "body", field: "name", code: "max_length", message: "too long" }],
          },
        },
      }

      const retryable: Popup = {
        message: "Couldn't create the business.",
        retry: Operation.CreateBusiness({ name: "Acme Ltd" }),
        close: "refresh",
      }

      const cases: ReadonlyArray<readonly [Reply, Popup]> = [
        [tooLong, { message: "Enter a business name of at most 255 characters.", retry: null, close: "dismiss" }],
        [failure(409, "conflict"), { message: "This key already has a business.", retry: null, close: "refresh" }],
        [
          failure(503, "country_unavailable"),
          { message: "Businesses can't be created in this country yet.", retry: null, close: "refresh" },
        ],
        [{ status: 500, body: {} }, retryable],
        ["unreachable", retryable],
      ]

      for (const [reply, popup] of cases) {
        const plane = fakePlane({ me: me(null), createBusiness: () => reply })

        const state = yield* run(plane, loadThen((session) => session.createBusiness("Acme Ltd")))

        assert.deepEqual(state, idle(View.NoBusiness(), popup), popup.message)
      }
    }),
  ),
)

void test(
  "Close after a create conflict reloads /me once and shows the business that won",
  scenario(
    Effect.gen(function* () {
      const plane = fakePlane({ me: inTurn(me(null)(), me(active)()), createBusiness: () => failure(409, "conflict") })

      const state = yield* run(plane, loadThen((session) => Effect.andThen(session.createBusiness("Acme Ltd"), session.close)))

      assert.deepEqual(state, idle(home(active, 4)))
      assert.deepEqual(paths(plane), ["POST /session", "GET /me", "POST /business", "GET /me", "GET /business/balance"])
    }),
  ),
)

void test(
  "Close after a lost create answer finds the business that was made",
  scenario(
    Effect.gen(function* () {
      const plane = fakePlane({ me: inTurn(me(null)(), me(business())()), createBusiness: () => "unreachable" })

      const state = yield* run(plane, loadThen((session) => Effect.andThen(session.createBusiness("Acme Ltd"), session.close)))

      assert.deepEqual(state, idle(home(business())))
      assert.deepEqual(paths(plane), ["POST /session", "GET /me", "POST /business", "GET /me"])
    }),
  ),
)

void test(
  "Close with still no business shows the form again",
  scenario(
    Effect.gen(function* () {
      const plane = fakePlane({ me: me(null), createBusiness: () => failure(503, "country_unavailable") })

      const state = yield* run(plane, loadThen((session) => Effect.andThen(session.createBusiness("Acme Ltd"), session.close)))

      assert.deepEqual(state, idle(View.NoBusiness()))
    }),
  ),
)

void test(
  "Retry repeats the create with the name that was submitted",
  scenario(
    Effect.gen(function* () {
      const plane = fakePlane({
        me: me(null),
        createBusiness: inTurn("unreachable", { status: 200, body: business() }),
      })

      const state = yield* run(
        plane,
        loadThen((session) => Effect.andThen(session.createBusiness(" Acme Ltd "), session.retry)),
      )

      assert.deepEqual(state, idle(home(business())))
      assert.deepEqual(
        plane.calls.filter(({ path }) => path === "/business").map(({ body }) => body),
        [
          { name: "Acme Ltd", country_code: "NG" },
          { name: "Acme Ltd", country_code: "NG" },
        ],
      )
    }),
  ),
)

void test(
  "nothing is sent while a request is in flight or a popup is open",
  scenario(
    Effect.gen(function* () {
      const plane = fakePlane({ me: me(null), createBusiness: () => "unreachable" })

      yield* run(plane, (session) =>
        Effect.gen(function* () {
          yield* session.load
          yield* SubscriptionRef.update(session.state, (state) => ({ ...state, pending: true }))
          yield* session.createBusiness("Acme Ltd")
          yield* SubscriptionRef.update(session.state, (state) => ({ ...state, pending: false }))

          assert.deepEqual(paths(plane), ["POST /session", "GET /me"])

          yield* session.createBusiness("Acme Ltd")
          // The popup is open now.
          yield* session.createBusiness("Acme Ltd")
          yield* SubscriptionRef.update(session.state, (state) => ({ ...state, pending: true }))
          yield* session.retry
          yield* session.close
        }),
      )

      assert.deepEqual(paths(plane), ["POST /session", "GET /me", "POST /business"])
    }),
  ),
)

void test(
  "opening the ledger account shows the active business",
  scenario(
    Effect.gen(function* () {
      const plane = fakePlane({ me: me(business()), openAccount: () => ({ status: 200, body: active }) })

      const state = yield* run(plane, loadThen((session) => session.openAccount))
      const call = plane.calls.find(({ path }) => path === "/business/account")

      assert.deepEqual(state, idle(home(active, 2)))
      assert.deepEqual([call?.method, call?.path, call?.body], ["POST", "/business/account", null])
    }),
  ),
)

// Payouts with nothing saved, as a business first sees them.
const unsaved = () => ({ status: 200, body: payoutSettings() })


void test(
  "payouts with no payout account open on its form, and Back leaves payouts",
  scenario(
    Effect.gen(function* () {
      const plane = fakePlane({ me: me(active), payoutSettings: unsaved })

      yield* run(plane, (session) =>
        Effect.gen(function* () {
          yield* session.load
          yield* current(session)
          yield* session.managePayouts

          assert.deepEqual(
            yield* current(session),
            idle(View.PayoutSettings({
              business: active,
              settings: payoutSettings(),
              banks,
              origin: SettingsOrigin.Setup(),
            })),
          )

          yield* session.back

          assert.deepEqual(yield* current(session), idle(home(active, 3)))
        }),
      )

      // The first page comes with the settings, though without a payout account it is not shown.
      assert.deepEqual(paths(plane).filter((path) => path.includes("/payouts")).sort(), [
        "GET /payouts",
        "GET /payouts/banks",
        "GET /payouts/settings",
      ])
    }),
  ),
)

void test(
  "with no payout account, a history request that never answers doesn't hold up the form",
  scenario(
    Effect.gen(function* () {
      const plane = fakePlane({ me: me(active), payoutSettings: unsaved, listPayouts: () => "hang" })

      const state = yield* run(plane, loadThen((session) => session.managePayouts))

      assert.ok(View.$is("PayoutSettings")(state.view))
      assert.equal(state.pending, false)
    }),
  ),
)

void test(
  "saving the payout account from that form shows the payouts under it",
  scenario(
    Effect.gen(function* () {
      const plane = fakePlane({ me: me(active), payoutSettings: unsaved })

      const state = yield* run(
        plane,
        loadThen((session) =>
          Effect.andThen(
            session.managePayouts,
            session.savePayoutSettings({ mode: "manual", bank: 1, accountNumber: "0123456789" }),
          )
        ),
      )

      assert.deepEqual(
        state,
        idle(View.Payouts({
          business: active,
          settings: payoutSettings({ destination: gtbank }),
          page: { payouts: [], next: null },
        })),
      )
    }),
  ),
)

void test(
  "a ledger refusal is Close-only; a temporary failure offers Retry",
  scenario(
    Effect.gen(function* () {
      const refused: Popup = {
        message: "The ledger couldn't open an account for this business. Contact support.",
        retry: null,
        close: "refresh",
      }

      const retryable: Popup = {
        message: "Couldn't open the account.",
        retry: Operation.OpenAccount(),
        close: "refresh",
      }

      const cases: ReadonlyArray<readonly [string, Reply, Popup]> = [
        ["ledger_rejected", failure(409, "ledger_rejected"), refused],
        ["conflict", failure(409, "conflict"), refused],
        [
          "business_required",
          failure(409, "business_required"),
          { message: "Create a business first.", retry: null, close: "refresh" },
        ],
        ["ledger_unavailable", failure(503, "ledger_unavailable"), retryable],
        ["ledger_bad_response", failure(502, "ledger_bad_response"), retryable],
        ["500", { status: 500, body: {} }, retryable],
        ["unreachable", "unreachable", retryable],
      ]

      for (const [name, reply, popup] of cases) {
        const plane = fakePlane({ me: me(business()), openAccount: () => reply })

        const state = yield* run(plane, loadThen((session) => session.openAccount))

        assert.deepEqual(state, idle(home(business()), popup), name)
      }
    }),
  ),
)

void test(
  "a refused ledger call can't be resent from its popup, and Close reloads without resending",
  scenario(
    Effect.gen(function* () {
      for (const code of ["conflict", "ledger_rejected"]) {
        const plane = fakePlane({ me: me(business()), openAccount: () => failure(409, code) })

        const state = yield* run(
          plane,
          loadThen((session) =>
            Effect.gen(function* () {
              yield* session.openAccount
              yield* session.openAccount
              yield* session.retry
              yield* session.close
            }),
          ),
        )

        assert.deepEqual(state, idle(home(business())), code)
        assert.deepEqual(paths(plane), ["POST /session", "GET /me", "POST /business/account", "GET /me"], code)
      }
    }),
  ),
)

void test(
  "Retry repeats a temporary ledger failure and its success clears the popup",
  scenario(
    Effect.gen(function* () {
      const plane = fakePlane({
        me: me(business()),
        openAccount: inTurn(failure(503, "ledger_unavailable"), failure(502, "ledger_bad_response"), {
          status: 200,
          body: active,
        }),
      })

      yield* run(plane, (session) =>
        Effect.gen(function* () {
          yield* session.load
          yield* session.openAccount
          yield* session.retry

          // Another failure keeps the popup, still offering Retry.
          assert.equal((yield* current(session)).popup?.message, "Couldn't open the account.")

          yield* session.retry

          assert.deepEqual(yield* current(session), idle(home(active, 4)))
        }),
      )
    }),
  ),
)

void test(
  "a failed refresh shows its own popup, never the form, and doesn't load again by itself",
  scenario(
    Effect.gen(function* () {
      const plane = fakePlane({ me: inTurn(me(null)(), "unreachable"), createBusiness: () => failure(409, "conflict") })

      const state = yield* run(plane, loadThen((session) => Effect.andThen(session.createBusiness("Acme Ltd"), session.close)))

      assert.deepEqual(state, loadFailed)
      assert.deepEqual(paths(plane), ["POST /session", "GET /me", "POST /business", "GET /me"])
    }),
  ),
)

void test(
  "an active business never asks to open again, and one plane no longer finds is reloaded on Close",
  scenario(
    Effect.gen(function* () {
      const activePlane = fakePlane({ me: me(active), openAccount: () => ({ status: 200, body: active }) })

      yield* run(activePlane, loadThen((session) => session.openAccount))

      assert.equal(activePlane.calls.some(({ path }) => path === "/business/account"), false)

      const gone = fakePlane({ me: inTurn(me(business())(), me(null)()), openAccount: () => failure(409, "business_required") })

      const state = yield* run(gone, loadThen((session) => Effect.andThen(session.openAccount, session.close)))

      assert.deepEqual(state, idle(View.NoBusiness()))
    }),
  ),
)


void test("payments retain their origin; retry repeats the exact page, more appends, and filters and refresh reset paging", scenario(
  Effect.gen(function* () {
    const first = merchantPayment()
    const second = merchantPayment({ id: "pay_two" })

    const plane = fakePlane({
      me: me(active),
      listPaymentLinks: listed(paid, tips),
      listPayments: inTurn(
        { status: 200, body: paymentPage([first], "cursor_one") },
        "unreachable",
        { status: 200, body: paymentPage([second]) },
        { status: 200, body: paymentPage([first]) },
        { status: 200, body: paymentPage([]) },
      ),
    })

    yield* run(plane, (session) => Effect.gen(function* () {
      yield* session.load
      yield* session.manageLinks
      yield* session.openLink(paid.id)

      const origin = (yield* current(session)).view

      yield* session.linkPayments(paid.id)
      yield* session.morePayments

      const failed = yield* current(session)

      assert.ok(failed.popup?.retry !== null)
      assert.equal(failed.view._tag, "Payments")

      yield* session.retry

      const loaded = (yield* current(session)).view

      assert.ok(View.$is("Payments")(loaded))
      assert.deepEqual(loaded.page.payments.map((payment) => payment.id), [first.id, second.id])
      assert.deepEqual(loaded.origin, origin)

      yield* session.openPayment(second.id)

      assert.equal((yield* current(session)).view._tag, "PaymentDetail")

      yield* session.back

      assert.deepEqual((yield* current(session)).view, loaded)

      yield* session.filterPayments("settled")

      const filtered = (yield* current(session)).view

      assert.ok(View.$is("Payments")(filtered))
      assert.equal(filtered.filter.state, "settled")
      assert.equal(filtered.page.payments.length, 1)

      yield* session.refreshPayments
      yield* session.back

      assert.deepEqual((yield* current(session)).view, origin)

      assert.deepEqual(
        plane.calls.filter((call) => call.path.startsWith("/payments/")).map((call) => call.path),
        ["/payments/" + second.id],
      )

      const requests = plane.calls.filter((call) => call.path === "/payments")

      assert.deepEqual(requests.map((call) => call.query.get("before")), [null, "cursor_one", "cursor_one", null, null])
      assert.deepEqual(requests.map((call) => call.query.get("state")), [null, null, null, "settled", "settled"])
      assert.ok(requests.every((call) => call.query.get("link_id") === paid.id))
    }))
  }),
))

void test("business payments return to the business; unavailable link filters close back without retry", scenario(
  Effect.gen(function* () {
    const plane = fakePlane({
      me: me(active), listPaymentLinks: listed(paid),
      listPayments: inTurn({ status: 200, body: paymentPage() }, failure(404, "not_found")),
    })

    yield* run(plane, (session) => Effect.gen(function* () {
      yield* session.load
      yield* session.managePayments
      yield* session.back

      assert.deepEqual((yield* current(session)).view, home(active, 3))

      yield* session.manageLinks
      yield* session.openLink(paid.id)
      yield* session.linkPayments(paid.id)

      assert.equal((yield* current(session)).popup?.retry, null)

      yield* session.close

      assert.equal((yield* current(session)).view._tag, "Links")
    }))
  }),
))

const balanceCalls = (plane: ReturnType<typeof fakePlane>) =>
  plane.calls.filter(({ path }) => path === "/business/balance").length

// The state as it is, without waiting on a balance.
const now = (session: Session.Interface) => SubscriptionRef.get(session.state)

// Long enough for an answer already released to land, if it is going to.
const landed = Effect.sleep("20 millis")

const loadingHome = (request: number) => View.HasBusiness({ business: active, balance: Balance.Loading({ request }) })

void test("home loads its balance beside it, without marking anything pending", scenario(
  Effect.gen(function* () {
    const held = yield* Deferred.make<Reply>()
    const plane = fakePlane({ me: me(active), balance: () => ({ held }) })

    yield* run(plane, (session) => Effect.gen(function* () {
      yield* session.load

      assert.deepEqual(yield* now(session), idle(loadingHome(1)))

      yield* Deferred.succeed(held, { status: 200, body: figures({ available: "250000", incoming: "1500", held: "2500" }) })

      assert.deepEqual(yield* current(session), idle(View.HasBusiness({
        business: active,
        balance: Balance.Loaded({ request: 1, figures: figures({ available: "250000", incoming: "1500", held: "2500" }) }),
      })))
    }))

    assert.deepEqual(paths(plane), ["POST /session", "GET /me", "GET /business/balance"])
  }),
))

void test("a failed balance is unavailable inline, never a popup, and r fetches it again", scenario(
  Effect.gen(function* () {
    const replies: ReadonlyArray<readonly [string, Reply]> = [
      ["unreachable", "unreachable"],
      ["500", { status: 500, body: {} }],
      ["ledger_unavailable", failure(503, "ledger_unavailable")],
      ["ledger_bad_response", failure(502, "ledger_bad_response")],
      ["account_not_opened", failure(409, "account_not_opened")],
    ]

    for (const [name, reply] of replies) {
      const plane = fakePlane({ me: me(active), balance: inTurn(reply, { status: 200, body: figures() }) })

      yield* run(plane, (session) => Effect.gen(function* () {
        yield* session.load

        assert.deepEqual(
          yield* current(session),
          idle(View.HasBusiness({ business: active, balance: Balance.Unavailable({ request: 1 }) })),
          name,
        )

        yield* session.refreshBalance

        assert.deepEqual(yield* current(session), idle(home(active, 2)), name)
      }))
    }
  }),
))

void test("r while the balance loads does nothing, and nothing asks for one without an open account", scenario(
  Effect.gen(function* () {
    const held = yield* Deferred.make<Reply>()
    const plane = fakePlane({ me: me(active), balance: () => ({ held }) })

    yield* run(plane, (session) => Effect.gen(function* () {
      yield* session.load
      yield* landed
      yield* session.refreshBalance
      yield* landed

      assert.deepEqual(yield* now(session), idle(loadingHome(1)))
      assert.equal(balanceCalls(plane), 1)
    }))

    // Recorded but not yet activated counts as no account.
    for (const shown of [business(), business({ ledger: active.ledger })]) {
      const unopened = fakePlane({ me: me(shown) })

      yield* run(unopened, (session) => Effect.andThen(session.load, session.refreshBalance))

      assert.equal(balanceCalls(unopened), 0)
    }
  }),
))

void test("the menu works while the balance is outstanding or unavailable", scenario(
  Effect.gen(function* () {
    const held = yield* Deferred.make<Reply>()
    const outstanding = fakePlane({ me: me(active), listPaymentLinks: listed(paid), balance: () => ({ held }) })

    yield* run(outstanding, (session) => Effect.gen(function* () {
      yield* session.load
      yield* session.managePayments

      assert.equal((yield* now(session)).view._tag, "Payments")

      yield* session.back
      yield* session.manageLinks

      assert.deepEqual(yield* now(session), idle(View.Links({ business: active, overview: overview([paid]) })))
    }))

    const unavailable = fakePlane({ me: me(active), balance: () => failure(503, "ledger_unavailable") })

    yield* run(unavailable, (session) => Effect.gen(function* () {
      yield* session.load
      yield* current(session)
      yield* session.managePayments

      assert.equal((yield* now(session)).view._tag, "Payments")
    }))
  }),
))

void test("returning home from payments or links fetches the balance again", scenario(
  Effect.gen(function* () {
    const plane = fakePlane({ me: me(active) })

    yield* run(plane, (session) => Effect.gen(function* () {
      yield* session.load
      yield* current(session)
      yield* session.managePayments
      yield* session.back

      assert.deepEqual(yield* current(session), idle(home(active, 3)))

      yield* session.manageLinks
      yield* session.back

      assert.deepEqual(yield* current(session), idle(home(active, 5)))
    }))

    assert.equal(balanceCalls(plane), 3)
  }),
))

void test("an answer for a home that's gone, or for an earlier visit, is dropped", scenario(
  Effect.gen(function* () {
    const earlier = yield* Deferred.make<Reply>()
    const later = yield* Deferred.make<Reply>()
    const plane = fakePlane({ me: me(active), balance: first({ held: earlier }, { held: later })(() => "hang") })

    yield* run(plane, (session) => Effect.gen(function* () {
      yield* session.load
      yield* session.managePayments

      const away = yield* now(session)

      // Home is gone: the first answer changes nothing.
      yield* Deferred.succeed(earlier, { status: 200, body: figures({ available: "100" }) })
      yield* landed

      assert.deepEqual(yield* now(session), away)

      // Back home under a new request; the old answer has already been spent,
      // and only the new one's figures show.
      yield* session.back

      assert.deepEqual(yield* now(session), idle(loadingHome(3)))

      yield* Deferred.succeed(later, { status: 200, body: figures({ available: "200" }) })

      assert.deepEqual(yield* current(session), idle(View.HasBusiness({
        business: active,
        balance: Balance.Loaded({ request: 3, figures: figures({ available: "200" }) }),
      })))
    }))
  }),
))

void test("leaving and re-entering home, the first answer to land doesn't stand in for the second", scenario(
  Effect.gen(function* () {
    const earlier = yield* Deferred.make<Reply>()
    const later = yield* Deferred.make<Reply>()
    const plane = fakePlane({ me: me(active), balance: first({ held: earlier }, { held: later })(() => "hang") })

    yield* run(plane, (session) => Effect.gen(function* () {
      yield* session.load
      yield* session.managePayments
      yield* session.back

      assert.deepEqual(yield* now(session), idle(loadingHome(3)))

      yield* Deferred.succeed(earlier, { status: 200, body: figures({ available: "100" }) })
      yield* landed

      assert.deepEqual(yield* now(session), idle(loadingHome(3)))

      yield* Deferred.succeed(later, { status: 200, body: figures({ available: "200" }) })

      assert.deepEqual(yield* current(session), idle(View.HasBusiness({
        business: active,
        balance: Balance.Loaded({ request: 3, figures: figures({ available: "200" }) }),
      })))
    }))

    assert.equal(balanceCalls(plane), 2)
  }),
))

const statementCalls = (plane: ReturnType<typeof fakePlane>) =>
  plane.calls.filter(({ path }) => path === "/business/statement").map(({ query }) => Object.fromEntries(query))

void test("the statement opens on 30 days, pages by cursor alone, and a period or refresh starts over", scenario(
  Effect.gen(function* () {
    const newest = statement([movement()], { next: "older" })
    const middle = statement([meetup], { previous: "newer", next: "oldest" })

    const plane = fakePlane({
      me: me(active),
      statement: inTurn(
        { status: 200, body: newest },
        { status: 200, body: middle },
        { status: 200, body: newest },
        { status: 200, body: statement([]) },
      ),
    })

    yield* run(plane, (session) => Effect.gen(function* () {
      yield* session.load
      yield* session.openStatement

      assert.deepEqual(yield* current(session), idle(View.Statement({ business: active, period: "30d", page: newest, landing: "first" })))

      yield* session.statementPage("next")

      assert.deepEqual(yield* current(session), idle(View.Statement({ business: active, period: "30d", page: middle, landing: "first" })))

      yield* session.statementPage("previous")

      assert.deepEqual(yield* current(session), idle(View.Statement({ business: active, period: "30d", page: newest, landing: "last" })))

      // No newer page: nothing is asked.
      yield* session.statementPage("previous")
      yield* session.statementPeriod("7d")

      assert.deepEqual(
        yield* current(session),
        idle(View.Statement({ business: active, period: "7d", page: statement([]), landing: "first" })),
      )

      yield* session.refreshStatement
      yield* session.statementPeriod("today")
    }))

    assert.deepEqual(statementCalls(plane), [
      { period: "30d" },
      { cursor: "older" },
      { cursor: "newer" },
      { period: "7d" },
      { period: "7d" },
      { period: "today" },
    ])
  }),
))

void test("leaving the statement goes home and fetches the balance again", scenario(
  Effect.gen(function* () {
    const plane = fakePlane({ me: me(active) })

    yield* run(plane, (session) => Effect.gen(function* () {
      yield* session.load
      yield* current(session)
      yield* session.openStatement
      yield* session.back

      assert.deepEqual(yield* current(session), idle(home(active, 3)))
    }))

    assert.equal(balanceCalls(plane), 2)
  }),
))

void test("the statement opens under a ledger even when the balance failed, and never without one", scenario(
  Effect.gen(function* () {
    const plane = fakePlane({ me: me(active), balance: () => failure(503, "ledger_unavailable") })

    yield* run(plane, (session) => Effect.gen(function* () {
      yield* session.load
      yield* current(session)
      yield* session.openStatement

      assert.equal((yield* now(session)).view._tag, "Statement")
    }))

    for (const shown of [business(), null]) {
      const unopened = fakePlane({ me: me(shown) })

      yield* run(unopened, (session) => Effect.andThen(session.load, session.openStatement))

      assert.deepEqual(statementCalls(unopened), [])
    }
  }),
))

void test("a failed statement offers Retry of the same page; a refused cursor offers r instead", scenario(
  Effect.gen(function* () {
    const older = statement([meetup], { previous: "newer" })

    const plane = fakePlane({
      me: me(active),
      statement: inTurn(
        { status: 200, body: statement([movement()], { next: "older" }) },
        "unreachable",
        { status: 200, body: older },
        {
          status: 400,
          body: {
            message: "Invalid statement cursor.",
            error: {
              code: "validation_error",
              details: [{ location: "query", field: "cursor", code: "invalid_value", message: "Invalid statement cursor." }],
            },
          },
        },
      ),
    })

    yield* run(plane, (session) => Effect.gen(function* () {
      yield* session.load
      yield* session.openStatement

      const shown = (yield* current(session)).view

      yield* session.statementPage("next")

      const failed = yield* current(session)

      assert.deepEqual(failed.view, shown)
      assert.deepEqual(failed.popup, {
        message: "Couldn't load your statement.",
        retry: Operation.ListStatement({ business: active, period: "30d", cursor: "older", landing: "first" }),
        close: "dismiss",
      })

      yield* session.retry

      assert.deepEqual(yield* current(session), idle(View.Statement({ business: active, period: "30d", page: older, landing: "first" })))

      yield* session.statementPage("previous")

      assert.deepEqual((yield* current(session)).popup, {
        message: "That page is no longer available. Press r to reload the period.",
        retry: null,
        close: "dismiss",
      })

      yield* session.close

      assert.deepEqual(yield* current(session), idle(View.Statement({ business: active, period: "30d", page: older, landing: "first" })))
    }))

    assert.deepEqual(statementCalls(plane), [{ period: "30d" }, { cursor: "older" }, { cursor: "older" }, { cursor: "newer" }])
  }),
))

const draft = payout({ status: "created", amount: "300000" })

void test(
  "an amount creates the payout, the confirmation shows it as plane holds it, and Back leaves it to expire for the amount form",
  scenario(
    Effect.gen(function* () {
      const plane = fakePlane({ me: me(active), createPayout: () => ({ status: 201, body: draft }) })

      const [confirming, left] = yield* run(plane, (session) =>
        Effect.gen(function* () {
          yield* session.load
          yield* current(session)
          yield* session.managePayouts
          yield* session.startPayout
          yield* session.createPayout("3,000")

          const shown = yield* current(session)

          yield* session.back

          return [shown, yield* current(session)] as const
        }),
      )

      assert.ok(View.$is("ConfirmingPayout")(confirming.view))
      assert.deepEqual([confirming.view.payout, confirming.pending, confirming.popup], [draft, false, null])
      assert.ok(View.$is("RequestingPayout")(left.view))
      assert.equal(left.popup, null)
      assert.deepEqual(plane.calls.find(({ method, path }) => method === "POST" && path === "/payouts")?.body, { amount: 300_000 })
      assert.ok(plane.calls.every(({ idempotencyKey }) => idempotencyKey === null), "no key: confirm is by ID")
      assert.equal(plane.calls.at(-1)?.path, "/payouts", "Back asks plane nothing")
    }),
  ),
)

void test(
  "a confirmation plane can't go on says why; Close goes back to the amount form, or to the list read again when plane cancelled it",
  scenario(
    Effect.gen(function* () {
      const refusals = [
        ["payout_expired", "This payout wasn't confirmed in time, so nothing was paid. Enter the amount again.", "back"],
        ["payout_cancelled", "This payout was cancelled, so nothing was paid.", "payouts"],
        ["payout_rules_changed", "Payout rules changed, so this payout was cancelled and nothing was paid.", "payouts"],
      ] as const

      for (const [code, message, close] of refusals) {
        const plane = fakePlane({ me: me(active), confirmPayout: () => failure(409, code) })

        const [refused, closed] = yield* run(plane, (session) =>
          Effect.gen(function* () {
            yield* session.load
            yield* current(session)
            yield* session.managePayouts
            yield* session.startPayout
            yield* session.createPayout("2,500")
            yield* session.confirmPayout

            const shown = yield* current(session)

            yield* session.close

            return [shown, yield* current(session)] as const
          }),
        )

        assert.deepEqual(refused.popup, { message, retry: null, close }, code)
        assert.equal(closed.view._tag, close === "back" ? "RequestingPayout" : "Payouts", code)
        assert.equal(closed.popup, null)
      }

      // Anything plane didn't decide is safe to repeat: confirming is by ID.
      const plane = fakePlane({ me: me(active), confirmPayout: () => "unreachable" })

      const state = yield* run(plane, loadThen((session) =>
        Effect.gen(function* () {
          yield* session.managePayouts
          yield* session.startPayout
          yield* session.createPayout("2,500")
          yield* session.confirmPayout
        })))

      assert.deepEqual(state.popup, {
        message: "Couldn't confirm the payout.",
        retry: Operation.ConfirmPayout({
          list: View.Payouts({ business: active, settings: payoutSettings({ destination: gtbank }), page: { payouts: [], next: null } }),
          payout: payout({ status: "created" }),
        }),
        close: "payouts",
      })
    }),
  ),
)

void test(
  "a create plane refuses says why, with nothing to retry",
  scenario(
    Effect.gen(function* () {
      const refusals = [
        ["payout_drafts_full", "Too many payouts are waiting to be confirmed. Wait a moment for them to expire, then try again.", "dismiss"],
        ["payout_ledger_mismatch", "A payout doesn't match the ledger. Support will correct it before you can request another.", "payouts"],
        ["payouts_automatic", "Payouts are automatic, so plane pays you out daily.", "payouts"],
        ["no_payout_account", "Save a payout account whose bank takes payouts first.", "dismiss"],
      ] as const

      for (const [code, message, close] of refusals) {
        const plane = fakePlane({ me: me(active), createPayout: () => failure(409, code) })

        const state = yield* run(plane, loadThen((session) =>
          Effect.gen(function* () {
            yield* session.managePayouts
            yield* session.startPayout
            yield* session.createPayout("2,500")
          })))

        assert.ok(View.$is("RequestingPayout")(state.view), code)
        assert.deepEqual(state.popup, { message, retry: null, close }, code)
      }
    }),
  ),
)

void test("a saved bank no longer listed is left for the merchant to choose again", () => {
  const settings = payoutSettings({ destination: { ...gtbank, bank_code: "999", bank_name: "999" } })
  const form = formOf(settings, banks)

  assert.equal(form.bank, null)
  assert.deepEqual(toSettingsRequest(form, banks), Result.fail("Choose a bank."))
})

void test(
  "payouts in a currency without them say so, with nothing to retry",
  scenario(
    Effect.gen(function* () {
      const plane = fakePlane({ me: me(active), payoutSettings: () => failure(409, "payouts_unavailable") })

      const state = yield* run(plane, loadThen((session) => session.managePayouts))

      assert.deepEqual(state.popup, {
        message: "Payouts aren't available in your account's currency yet.",
        retry: null,
        close: "dismiss",
      })
    }),
  ),
)

void test(
  "Back from a payout keeps the list's pages and shows that payout as last read, asking plane nothing",
  scenario(
    Effect.gen(function* () {
      const older = payout({ id: "pout_older", status: "paid" })

      const plane = fakePlane({
        me: me(active),
        listPayouts: () => ({ status: 200, body: { payouts: [payout(), older], next: null } }),
        getPayout: () => ({ status: 200, body: payout({ status: "held" }) }),
      })

      const state = yield* run(
        plane,
        loadThen((session) => Effect.andThen(Effect.andThen(session.managePayouts, session.openPayout(payout().id)), session.back)),
      )

      assert.ok(View.$is("Payouts")(state.view))
      assert.deepEqual(state.view.page.payouts, [payout({ status: "held" }), older])
      assert.equal(paths(plane).at(-1), `GET /payouts/${payout().id}`)
    }),
  ),
)

void test(
  "a confirm refused for automatic payouts closes to the payout list, read again",
  scenario(
    Effect.gen(function* () {
      let mode: "manual" | "automatic" = "manual"

      const plane = fakePlane({
        me: me(active),
        payoutSettings: () => ({ status: 200, body: payoutSettings({ mode, destination: gtbank }) }),
        confirmPayout: () => {
          mode = "automatic"

          return failure(409, "payouts_automatic")
        },
      })

      const [refused, closed] = yield* run(plane, (session) =>
        Effect.gen(function* () {
          yield* session.load
          yield* current(session)
          yield* session.managePayouts
          yield* session.startPayout
          yield* session.createPayout("2,500")
          yield* session.confirmPayout

          const shown = yield* current(session)

          yield* session.close

          return [shown, yield* current(session)] as const
        }),
      )

      assert.deepEqual(refused.popup, {
        message: "Payouts are automatic now, so this payout was cancelled and plane pays you out daily.",
        retry: null,
        close: "payouts",
      })
      assert.ok(View.$is("Payouts")(closed.view))
      assert.equal(closed.view.settings.mode, "automatic")
    }),
  ),
)

void test(
  "a payout just requested joins the top of the list on Back",
  scenario(
    Effect.gen(function* () {
      const plane = fakePlane({ me: me(active) })

      const state = yield* run(
        plane,
        loadThen((session) =>
          Effect.gen(function* () {
            yield* session.managePayouts
            yield* session.startPayout
            yield* session.createPayout("2,500")
            yield* session.confirmPayout
            yield* session.back
          })
        ),
      )

      assert.ok(View.$is("Payouts")(state.view))
      assert.deepEqual(state.view.page.payouts, [payout()])
      assert.deepEqual(paths(plane).filter((path) => path.startsWith("POST /payouts")), [
        "POST /payouts",
        `POST /payouts/${payout().id}/confirm`,
      ])
    }),
  ),
)

const payoutReads = (plane: ReturnType<typeof fakePlane>) =>
  paths(plane).filter((path) => path === `GET /payouts/${payout().id}`).length

// Polls the session until `done` holds of what it shows.
const until = (session: Session.Interface, done: (state: State) => boolean) =>
  Effect.gen(function* () {
    for (let tries = 0; tries < 200; tries++) {
      const state = yield* SubscriptionRef.get(session.state)

      if (done(state)) {
        return state
      }

      yield* Effect.sleep("5 millis")
    }

    return assert.fail("the session never got there")
  })

const showingPayout = (status: string) => (state: State) =>
  View.$is("PayoutDetail")(state.view) && state.view.payout.status === status

void test(
  "a payout's screen follows it through sent to paid on its own, and stops once it settles",
  scenario(
    Effect.gen(function* () {
      const plane = fakePlane({
        me: me(active),
        listPayouts: () => ({ status: 200, body: { payouts: [payout({ status: "held" })], next: null } }),
        getPayout: inTurn(
          { status: 200, body: payout({ status: "held" }) },
          { status: 200, body: payout({ status: "sent", sent_at: "2026-11-10T09:00:01.000Z" }) },
          {
            status: 200,
            body: payout({ status: "paid", sent_at: "2026-11-10T09:00:01.000Z", completed_at: "2026-11-10T09:00:06.000Z" }),
          },
        ),
      })

      yield* runFollowing(plane, Duration.millis(10), (session) =>
        Effect.gen(function* () {
          yield* loadThen((loaded) => Effect.andThen(loaded.managePayouts, loaded.openPayout(payout().id)))(session)

          // Each step shows idle: the screen stays usable while it is read again.
          assert.equal((yield* until(session, showingPayout("sent"))).pending, false)

          const settled = yield* until(session, showingPayout("paid"))

          assert.equal(settled.pending, false)

          const reads = payoutReads(plane)

          yield* Effect.sleep("60 millis")

          assert.equal(payoutReads(plane), reads, "nothing is read once it settles")
          assert.equal(reads, 3)

          // Back shows it settled on the list.
          yield* session.back

          const list = yield* SubscriptionRef.get(session.state)

          assert.ok(View.$is("Payouts")(list.view))
          assert.deepEqual(list.view.page.payouts.map((shown) => shown.status), ["paid"])
        }))
    }),
  ),
)

void test(
  "a failed payout is followed to failed; leaving its screen stops the follow",
  scenario(
    Effect.gen(function* () {
      const failed = payout({ status: "failed", sent_at: "2026-11-10T09:00:01.000Z", completed_at: "2026-11-10T09:00:06.000Z" })

      const plane = fakePlane({
        me: me(active),
        listPayouts: () => ({ status: 200, body: { payouts: [payout({ status: "sent" })], next: null } }),
        getPayout: inTurn({ status: 200, body: payout({ status: "sent" }) }, { status: 200, body: failed }),
      })

      yield* runFollowing(plane, Duration.millis(10), (session) =>
        Effect.gen(function* () {
          yield* loadThen((loaded) => Effect.andThen(loaded.managePayouts, loaded.openPayout(payout().id)))(session)
          yield* until(session, showingPayout("failed"))
        }))

      // Left on its list straight after opening, a moving payout is read no more.
      const leaving = fakePlane({
        me: me(active),
        listPayouts: () => ({ status: 200, body: { payouts: [payout({ status: "sent" })], next: null } }),
        getPayout: () => ({ status: 200, body: payout({ status: "sent" }) }),
      })

      yield* runFollowing(leaving, Duration.millis(10), (session) =>
        Effect.gen(function* () {
          yield* loadThen((loaded) => Effect.andThen(loaded.managePayouts, loaded.openPayout(payout().id)))(session)
          yield* session.back

          const reads = payoutReads(leaving)

          yield* Effect.sleep("60 millis")

          assert.equal(payoutReads(leaving), reads)
        }))
    }),
  ),
)

void test(
  "a follow read answered after a newer read of the payout doesn't put the older status back",
  scenario(
    Effect.gen(function* () {
      const stale = yield* Deferred.make<Reply>()
      const sent = payout({ status: "sent", sent_at: "2026-11-10T09:00:01.000Z" })

      const plane = fakePlane({
        me: me(active),
        listPayouts: () => ({ status: 200, body: { payouts: [payout({ status: "held" })], next: null } }),
        // Opened held; the follow's read then hangs while r reads it sent.
        getPayout: inTurn({ status: 200, body: payout({ status: "held" }) }, { held: stale }, { status: 200, body: sent }),
      })

      yield* runFollowing(plane, Duration.millis(50), (session) =>
        Effect.gen(function* () {
          yield* loadThen((loaded) => Effect.andThen(loaded.managePayouts, loaded.openPayout(payout().id)))(session)

          for (let tries = 0; payoutReads(plane) < 2 && tries < 200; tries++) {
            yield* Effect.sleep("5 millis")
          }

          yield* session.openPayout(payout().id)
          yield* until(session, showingPayout("sent"))

          yield* Deferred.succeed(stale, { status: 200, body: payout({ status: "held" }) })
          yield* Effect.sleep("20 millis")

          assert.ok(showingPayout("sent")(yield* SubscriptionRef.get(session.state)))
        }))
    }),
  ),
)

void test(
  "a follow stops once the payout is gone, and backs off on any other failure",
  scenario(
    Effect.gen(function* () {
      const sent = { status: 200, body: payout({ status: "sent", sent_at: "2026-11-10T09:00:01.000Z" }) }

      const refused = fakePlane({
        me: me(active),
        listPayouts: () => ({ status: 200, body: { payouts: [payout({ status: "sent" })], next: null } }),
        getPayout: inTurn(sent, { status: 404, body: { message: "Payout not found.", error: { code: "not_found" } } }),
      })

      yield* runFollowing(refused, Duration.millis(10), (session) =>
        Effect.gen(function* () {
          yield* loadThen((loaded) => Effect.andThen(loaded.managePayouts, loaded.openPayout(payout().id)))(session)
          yield* Effect.sleep("100 millis")

          // The open, then the follow's one refused read.
          assert.equal(payoutReads(refused), 2)
        }))

      const failing = fakePlane({
        me: me(active),
        listPayouts: () => ({ status: 200, body: { payouts: [payout({ status: "sent" })], next: null } }),
        getPayout: inTurn(sent, { status: 503, body: { message: "Try again.", error: { code: "unavailable" } } }),
      })

      yield* runFollowing(failing, Duration.millis(10), (session) =>
        Effect.gen(function* () {
          yield* loadThen((loaded) => Effect.andThen(loaded.managePayouts, loaded.openPayout(payout().id)))(session)
          yield* Effect.sleep("100 millis")

          // Another code may pass, so the follow keeps reading.
          assert.ok(payoutReads(failing) > 2)
        }))

      const unreachable = fakePlane({
        me: me(active),
        listPayouts: () => ({ status: 200, body: { payouts: [payout({ status: "sent" })], next: null } }),
        getPayout: inTurn(sent, "unreachable"),
      })

      yield* runFollowing(unreachable, Duration.millis(10), (session) =>
        Effect.gen(function* () {
          yield* loadThen((loaded) => Effect.andThen(loaded.managePayouts, loaded.openPayout(payout().id)))(session)
          yield* Effect.sleep("150 millis")

          // Waits of 10, 20, 40 and 80 ms fit about four reads, not fifteen.
          const reads = payoutReads(unreachable)

          assert.ok(reads >= 2 && reads <= 6, `${reads} reads`)
        }))
    }),
  ),
)

void test(
  "a follow goes quiet without news, but never while a change waits behind a popup, which lands once it closes",
  scenario(
    Effect.gen(function* () {
      const sent = payout({ status: "sent", sent_at: "2026-11-10T09:00:01.000Z" })
      const paid = payout({ status: "paid", sent_at: "2026-11-10T09:00:01.000Z", completed_at: "2026-11-10T09:00:06.000Z" })

      const opened = (session: Session.Interface) =>
        loadThen((loaded) => Effect.andThen(loaded.managePayouts, loaded.openPayout(payout().id)))(session)

      // Nothing new: past the quiet limit it stops reading.
      const still = fakePlane({
        me: me(active),
        listPayouts: () => ({ status: 200, body: { payouts: [sent], next: null } }),
        getPayout: () => ({ status: 200, body: sent }),
      })

      yield* runQuieting(still, (session) =>
        Effect.gen(function* () {
          yield* opened(session)
          yield* Effect.sleep("250 millis")

          const reads = payoutReads(still)

          yield* Effect.sleep("100 millis")

          assert.equal(payoutReads(still), reads, "quiet, it reads no more")
        }))

      // A change held back by a popup: past the quiet limit it still reads,
      // and the change lands once the popup closes.
      let answer: "sent" | "refused" | "paid" = "sent"

      const held = fakePlane({
        me: me(active),
        listPayouts: () => ({ status: 200, body: { payouts: [sent], next: null } }),
        getPayout: () =>
          answer === "refused"
            ? { status: 503, body: { message: "Try again.", error: { code: "unavailable" } } }
            : { status: 200, body: answer === "paid" ? paid : sent },
      })

      yield* runQuieting(held, (session) =>
        Effect.gen(function* () {
          yield* opened(session)

          // `r` fails, leaving its popup up; the payout is then paid.
          answer = "refused"
          yield* session.openPayout(payout().id)
          assert.ok((yield* SubscriptionRef.get(session.state)).popup !== null)
          answer = "paid"

          yield* Effect.sleep("250 millis")

          const behind = yield* SubscriptionRef.get(session.state)

          assert.ok(View.$is("PayoutDetail")(behind.view))
          assert.equal(behind.view.payout.status, "sent", "held back by the popup")

          const reads = payoutReads(held)

          yield* Effect.sleep("60 millis")

          assert.ok(payoutReads(held) > reads, "still reading while the change waits")

          yield* session.close

          assert.equal((yield* until(session, showingPayout("paid"))).popup, null)
        }))
    }),
  ),
)

void test(
  "r reads a moving payout at once, without waiting for the follow",
  scenario(
    Effect.gen(function* () {
      const plane = fakePlane({
        me: me(active),
        getPayout: () => ({ status: 200, body: payout({ status: "sent", sent_at: "2026-11-10T09:00:01.000Z" }) }),
      })

      const state = yield* runFollowing(plane, Duration.hours(1), loadThen((session) =>
        Effect.gen(function* () {
          yield* session.managePayouts
          yield* session.startPayout
          yield* session.createPayout("2,500")
          yield* session.confirmPayout
          yield* session.openPayout(payout().id)
        })))

      assert.ok(showingPayout("sent")(state))
      assert.equal(payoutReads(plane), 1)
    }),
  ),
)

void test(
  "a created, cancelled or expired payout's screen isn't followed",
  scenario(
    Effect.gen(function* () {
      for (const status of ["created", "cancelled", "expired"] as const) {
        const shown = payout({ status })

        const plane = fakePlane({
          me: me(active),
          listPayouts: () => ({ status: 200, body: { payouts: [shown], next: null } }),
          getPayout: () => ({ status: 200, body: shown }),
        })

        yield* runFollowing(plane, Duration.millis(10), (session) =>
          Effect.gen(function* () {
            yield* loadThen((loaded) => Effect.andThen(loaded.managePayouts, loaded.openPayout(shown.id)))(session)
            yield* Effect.sleep("60 millis")

            assert.equal(payoutReads(plane), 1, status)
          }))
      }
    }),
  ),
)

void test("a payout's screen says where it stands before it is confirmed, and when it never will be", () => {
  const created = payout({ status: "created" })
  const cancelled = payout({ status: "cancelled", completed_at: "2026-11-10T09:01:00.000Z" })
  const expired = payout({ status: "expired", completed_at: "2026-11-10T09:01:30.000Z" })

  assert.equal(statusLine(created), "Not confirmed · nothing moves until it is, and it expires at 09:01:30 UTC")
  assert.equal(statusLine(cancelled), "Cancelled · nothing was paid")
  assert.equal(statusLine(expired), "Expired · it wasn't confirmed in time, so nothing was paid")

  assert.deepEqual(detailLines(created).slice(-1), ["Created: 2026-11-10 09:00 UTC"])
  assert.deepEqual(detailLines(cancelled).slice(-1), ["Cancelled: 2026-11-10 09:01 UTC"])
  assert.deepEqual(detailLines(expired).slice(-1), ["Expired: 2026-11-10 09:01 UTC"])
})

void test("a payout's screen says where it stands once sent, paid or failed", () => {
  const sent = payout({ status: "sent", sent_at: "2026-11-10T09:00:01.000Z" })
  const paidOut = payout({ status: "paid", sent_at: "2026-11-10T09:00:01.000Z", completed_at: "2026-11-10T09:00:06.000Z" })
  const failedOut = payout({ status: "failed", sent_at: "2026-11-10T09:00:01.000Z", completed_at: "2026-11-10T09:00:06.000Z" })

  assert.equal(statusLine(sent), "Sent to GTBank ••••6789 · waiting for the bank…")
  assert.equal(statusLine(paidOut), "Paid to GTBank ••••6789")
  assert.equal(statusLine(failedOut), "Failed · the bank didn't take it, so the money is going back to your balance")
  // A hold the ledger didn't release: the balance isn't promised.
  assert.equal(statusLine({ ...failedOut, ledger_mismatch: true }), "Failed · the bank didn't take it")

  assert.deepEqual(detailLines(sent).slice(-1), ["Sent: 2026-11-10 09:00 UTC"])
  assert.deepEqual(detailLines(paidOut).slice(-2), ["Sent: 2026-11-10 09:00 UTC", "Paid: 2026-11-10 09:00 UTC"])
  assert.deepEqual(detailLines(failedOut).slice(-1), ["Failed: 2026-11-10 09:00 UTC"])
  assert.deepEqual(detailLines({ ...failedOut, ledger_mismatch: true }).slice(-2), [
    "Failed: 2026-11-10 09:00 UTC",
    "Ledger doesn't match this payout · support will resolve it",
  ])
})
