import assert from "node:assert/strict"
import { test } from "node:test"

import { Effect, SubscriptionRef } from "effect"

import { Session, State } from "../src/session.ts"
import { active, business, failure, fakePlane, inTurn, me, type Reply, scenario, sessions, unauthorized } from "./support.ts"

// The session over the fake; its methods keep the client they were made
// with, so they run without it.
const run = <A>(plane: ReturnType<typeof fakePlane>, body: (session: Session.Interface) => Effect.Effect<A>) =>
  Effect.flatMap(Session.make("SHA256:key").pipe(Effect.provide(plane.layer)), body)

const current = (session: Session.Interface) => SubscriptionRef.get(session.state)

const loadThen = <A>(next: (session: Session.Interface) => Effect.Effect<A>) => (session: Session.Interface) =>
  Effect.andThen(session.load, Effect.andThen(next(session), current(session)))

void test(
  "a key with no business exchanges its fingerprint, loads /me, and shows the form",
  scenario(
    Effect.gen(function* () {
      const plane = fakePlane({ me: me(null) })

      const state = yield* run(plane, loadThen(() => Effect.void))

      assert.deepEqual(state, State.NoBusiness({ pending: false, error: null }))
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

      assert.deepEqual(state, State.HasBusiness({ business: active, pending: false, error: null }))
    }),
  ),
)

void test(
  "a failed load is an error, never the form, and loading again recovers",
  scenario(
    Effect.gen(function* () {
      const plane = fakePlane({ me: inTurn("unreachable", { status: 500, body: {} }, me(null)()) })

      yield* run(plane, (session) =>
        Effect.gen(function* () {
          for (const reason of ["unreachable", "500"]) {
            yield* session.load

            assert.ok(State.$is("LoadFailed")(yield* current(session)), reason)
          }

          yield* session.load

          assert.ok(State.$is("NoBusiness")(yield* current(session)))
        }),
      )
    }),
  ),
)

void test(
  "a refused exchange is a failed load",
  scenario(
    Effect.gen(function* () {
      const plane = fakePlane({ session: () => failure(403, "forbidden") })

      assert.ok(State.$is("LoadFailed")(yield* run(plane, loadThen(() => Effect.void))))
      assert.deepEqual(plane.calls.map(({ path }) => path), ["/session"])
    }),
  ),
)

void test(
  "a token is reused until it nears expiry, then exchanged again",
  scenario(
    Effect.gen(function* () {
      const lasting = fakePlane({ me: me(null) })

      yield* run(lasting, (session) => Effect.andThen(session.load, session.load))

      assert.deepEqual(lasting.calls.map(({ path, authorization }) => [path, authorization]), [
        ["/session", null],
        ["/me", "Bearer tok_1"],
        ["/me", "Bearer tok_1"],
      ])

      // Inside the renewal margin from the start, so every request renews.
      const expiring = fakePlane({ session: sessions(30), me: me(null) })

      yield* run(expiring, (session) => Effect.andThen(session.load, session.load))

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

      assert.ok(State.$is("NoBusiness")(yield* run(recovering, loadThen(() => Effect.void))))
      assert.deepEqual(recovering.calls.map(({ path, authorization }) => [path, authorization]), [
        ["/session", null],
        ["/me", "Bearer tok_1"],
        ["/session", null],
        ["/me", "Bearer tok_2"],
      ])

      const refused = fakePlane({ me: () => unauthorized })

      assert.ok(State.$is("LoadFailed")(yield* run(refused, loadThen(() => Effect.void))))
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

      assert.deepEqual(state, State.HasBusiness({ business: business(), pending: false, error: null }))
      assert.deepEqual(plane.calls.at(-1)?.body, { name: "Acme Ltd", country_code: "NG" })
    }),
  ),
)

void test(
  "a blank name is refused without asking plane",
  scenario(
    Effect.gen(function* () {
      const plane = fakePlane({ me: me(null) })

      const state = yield* run(plane, loadThen((session) => session.createBusiness(" \t ")))

      assert.deepEqual(state, State.NoBusiness({ pending: false, error: "Enter a business name." }))
      assert.equal(plane.calls.some(({ path }) => path === "/business"), false)
    }),
  ),
)

void test(
  "plane's refusals keep the form with a message; a conflict shows the business that won",
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

      const cases: ReadonlyArray<readonly [Reply, string]> = [
        [tooLong, "Enter a business name of at most 255 characters."],
        [failure(503, "country_unavailable"), "Businesses can't be created in this country yet."],
        [{ status: 500, body: {} }, "Couldn't create the business. Try again."],
        ["unreachable", "Couldn't create the business. Try again."],
      ]

      for (const [reply, error] of cases) {
        const plane = fakePlane({ me: me(null), createBusiness: () => reply })

        const state = yield* run(plane, loadThen((session) => session.createBusiness("Acme Ltd")))

        assert.deepEqual(state, State.NoBusiness({ pending: false, error }), error)
      }

      // Another connection for this key created one first.
      const raced = fakePlane({ me: inTurn(me(null)(), me(active)()), createBusiness: () => failure(409, "conflict") })

      const state = yield* run(raced, loadThen((session) => session.createBusiness("Acme Ltd")))

      assert.deepEqual(state, State.HasBusiness({ business: active, pending: false, error: null }))
    }),
  ),
)

void test(
  "a submit while one is in flight sends nothing",
  scenario(
    Effect.gen(function* () {
      const plane = fakePlane({ me: me(null), createBusiness: () => ({ status: 200, body: business() }) })

      yield* run(
        plane,
        loadThen((session) =>
          Effect.andThen(
            SubscriptionRef.set(session.state, State.NoBusiness({ pending: true, error: null })),
            session.createBusiness("Acme Ltd"),
          ),
        ),
      )

      assert.equal(plane.calls.some(({ path }) => path === "/business"), false)
    }),
  ),
)

void test(
  "opening the ledger account shows the active business",
  scenario(
    Effect.gen(function* () {
      const plane = fakePlane({ me: me(business()), openLedger: () => ({ status: 200, body: active }) })

      const state = yield* run(plane, loadThen((session) => session.openLedger))
      const call = plane.calls.at(-1)

      assert.deepEqual(state, State.HasBusiness({ business: active, pending: false, error: null }))
      assert.deepEqual([call?.method, call?.path, call?.body], ["POST", "/business/biz_1/ledger", null])
    }),
  ),
)

void test(
  "a failed ledger call keeps the created business with a message",
  scenario(
    Effect.gen(function* () {
      const refused = "The ledger couldn't open an account for this business. Contact support."
      const retry = "Couldn't open the account. Try again."

      const cases: ReadonlyArray<readonly [Reply, string]> = [
        [failure(409, "ledger_rejected"), refused],
        [failure(409, "conflict"), refused],
        [failure(503, "ledger_unavailable"), retry],
        [failure(502, "ledger_bad_response"), retry],
        [{ status: 500, body: {} }, retry],
        ["unreachable", retry],
      ]

      for (const [reply, error] of cases) {
        const plane = fakePlane({ me: me(business()), openLedger: () => reply })

        const state = yield* run(plane, loadThen((session) => session.openLedger))

        assert.deepEqual(state, State.HasBusiness({ business: business(), pending: false, error }), error)
      }
    }),
  ),
)

void test(
  "an active business never asks to open again, and one plane no longer finds is reloaded",
  scenario(
    Effect.gen(function* () {
      const activePlane = fakePlane({ me: me(active), openLedger: () => ({ status: 200, body: active }) })

      yield* run(activePlane, loadThen((session) => session.openLedger))

      assert.equal(activePlane.calls.some(({ path }) => path.endsWith("/ledger")), false)

      const gone = fakePlane({ me: inTurn(me(business())(), me(null)()), openLedger: () => failure(404, "not_found") })

      const state = yield* run(gone, loadThen((session) => session.openLedger))

      assert.deepEqual(state, State.NoBusiness({ pending: false, error: null }))
    }),
  ),
)
