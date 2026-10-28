import assert from "node:assert/strict"
import { test } from "node:test"

import { Deferred, Effect, SubscriptionRef } from "effect"

import { Balance, Operation, type Popup, Session, type State, View } from "../src/session.ts"
import { merchantPayment, paymentPage, paid, tips, listed, active, business, failure, fakePlane, figures, first, home, inTurn, me, meetup, movement, overview, type Reply, scenario, sessions, settled, statement, unauthorized } from "./support.ts"

// The session over the fake; its methods keep the client they were made
// with, so they run without it.
const run = <A, R>(plane: ReturnType<typeof fakePlane>, body: (session: Session.Interface) => Effect.Effect<A, never, R>) =>
  Effect.flatMap(Session.make("SHA256:key").pipe(Effect.provide(plane.layer)), body)

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

      yield* Deferred.succeed(held, { status: 200, body: figures({ available: "250000", pending: "1500" }) })

      assert.deepEqual(yield* current(session), idle(View.HasBusiness({
        business: active,
        balance: Balance.Loaded({ request: 1, figures: figures({ available: "250000", pending: "1500" }) }),
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
