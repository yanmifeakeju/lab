import type { AuthorizedClient, BusinessInfoEncoded } from "@pay-tty/plane-client"
import { Clock, Data, Effect, Match, Ref, Result, Schema, SubscriptionRef } from "effect"
import * as HttpClientError from "effect/unstable/http/HttpClientError"

import { Plane } from "./plane.ts"

export type Business = BusinessInfoEncoded

// What one SSH connection shows. A request in flight sets `pending`, and its
// failure lands in `error`, so the screen never waits on an exception.
export type State = Data.TaggedEnum<{
  Loading: {}
  LoadFailed: { readonly message: string }
  NoBusiness: { readonly pending: boolean; readonly error: string | null }
  HasBusiness: { readonly business: Business; readonly pending: boolean; readonly error: string | null }
}>

export const State = Data.taggedEnum<State>()

// Plane's declared errors arrive as their decoded bodies; anything else, a 500
// included, as a transport or decoding failure.
interface ApiError {
  readonly message: string
  readonly error: { readonly code: string }
}

type Failure = ApiError | HttpClientError.HttpClientError | Schema.SchemaError

const codeOf = (failure: Failure) =>
  HttpClientError.isHttpClientError(failure) || Schema.isSchemaError(failure) ? undefined : failure.error.code

// Renewed this long before it expires, so a request never carries a token
// that lapses on the way.
const renewMargin = 60_000

export interface Interface {
  readonly state: SubscriptionRef.SubscriptionRef<State>
  /** Loads the caller and their business; also the retry after a failed load. */
  readonly load: Effect.Effect<void>
  /** Ignored unless the form is showing and idle. */
  readonly createBusiness: (name: string) => Effect.Effect<void>
  /** Ignored unless a created business is showing and idle. */
  readonly openLedger: Effect.Effect<void>
}

/**
 * One connection's session, for the key that authenticated it. Nothing is
 * shared between connections, so each makes its own.
 */
export const make = Effect.fnUntraced(function* (fingerprint: string) {
  const plane = yield* Plane.Service
  const state = yield* SubscriptionRef.make<State>(State.Loading())
  const token = yield* Ref.make<{ readonly value: string; readonly expiresAt: number } | undefined>(undefined)

  // The SSH key already proved who this is; plane trades it for a token.
  const exchange = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    const session = yield* plane.createSession({ payload: { issuer: "ssh", sub: fingerprint } })

    yield* Ref.set(token, { value: session.accessToken, expiresAt: now + session.expiresIn * 1000 })

    return session.accessToken
  })

  const currentToken = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    const held = yield* Ref.get(token)

    return held !== undefined && held.expiresAt - now > renewMargin ? held.value : yield* exchange
  })

  // A 401 means plane stopped accepting the token, say after a key rotation:
  // exchange once more and retry, and give up if that is refused too.
  const authorized = <A, E extends Failure>(call: (client: AuthorizedClient) => Effect.Effect<A, E>) =>
    Effect.gen(function* () {
      const first = yield* Effect.result(Effect.flatMap(currentToken, (value) => call(plane.authorized(value))))

      if (Result.isSuccess(first)) {
        return first.success
      }

      if (codeOf(first.failure) !== "unauthorized") {
        return yield* Effect.fail(first.failure)
      }

      return yield* Effect.flatMap(exchange, (value) => call(plane.authorized(value)))
    })

  // A failed load is never "no business": the form only shows once /me says so.
  const load = Effect.gen(function* () {
    yield* SubscriptionRef.set(state, State.Loading())

    const me = yield* Effect.result(authorized((client) => client.me(undefined)))

    if (Result.isFailure(me)) {
      yield* Effect.logWarning("could not load the caller", me.failure)

      return yield* SubscriptionRef.set(state, State.LoadFailed({ message: "Couldn't load your account. Try again." }))
    }

    const { business } = me.success

    yield* SubscriptionRef.set(
      state,
      business === null
        ? State.NoBusiness({ pending: false, error: null })
        : State.HasBusiness({ business, pending: false, error: null }),
    )
  })

  const createBusiness = Effect.fnUntraced(function* (input: string) {
    const name = input.trim()

    const started = yield* SubscriptionRef.modify(state, (current) => {
      if (!State.$is("NoBusiness")(current) || current.pending) {
        return [false, current] as const
      }

      return name === ""
        ? ([false, State.NoBusiness({ pending: false, error: "Enter a business name." })] as const)
        : ([true, State.NoBusiness({ pending: true, error: null })] as const)
    })

    if (!started) {
      return
    }

    // Nigeria is the only country with a ledger; see TASK-004.
    const created = yield* Effect.result(
      authorized((client) => client.createBusiness({ payload: { name, country_code: "NG" } })),
    )

    if (Result.isSuccess(created)) {
      return yield* SubscriptionRef.set(state, State.HasBusiness({ business: created.success, pending: false, error: null }))
    }

    yield* Effect.logWarning("could not create the business", created.failure)

    const code = codeOf(created.failure)

    // Another connection for this key created one first: show that one.
    if (code === "conflict") {
      return yield* load
    }

    const error = Match.value(code).pipe(
      Match.when("validation_error", () => "Enter a business name of at most 255 characters."),
      Match.when("country_unavailable", () => "Businesses can't be created in this country yet."),
      Match.orElse(() => "Couldn't create the business. Try again."),
    )

    yield* SubscriptionRef.set(state, State.NoBusiness({ pending: false, error }))
  })

  const openLedger = Effect.gen(function* () {
    const business = yield* SubscriptionRef.modify(state, (current) =>
      State.$is("HasBusiness")(current) && !current.pending && current.business.status === "created"
        ? ([current.business, State.HasBusiness({ business: current.business, pending: true, error: null })] as const)
        : ([undefined, current] as const),
    )

    if (business === undefined) {
      return
    }

    const opened = yield* Effect.result(authorized((client) => client.createBusinessLedger(business.id, undefined)))

    if (Result.isSuccess(opened)) {
      return yield* SubscriptionRef.set(state, State.HasBusiness({ business: opened.success, pending: false, error: null }))
    }

    yield* Effect.logWarning("could not open the ledger account", opened.failure)

    const code = codeOf(opened.failure)

    if (code === "not_found") {
      return yield* load
    }

    // The business stays created whatever failed, so a retry is always safe;
    // only a refusal won't change by retrying.
    const error = Match.value(code).pipe(
      Match.when(
        (value) => value === "conflict" || value === "ledger_rejected",
        () => "The ledger couldn't open an account for this business. Contact support.",
      ),
      Match.orElse(() => "Couldn't open the account. Try again."),
    )

    yield* SubscriptionRef.set(state, State.HasBusiness({ business, pending: false, error }))
  })

  return { state, load, createBusiness, openLedger } satisfies Interface
})

export * as Session from "./session.ts"
