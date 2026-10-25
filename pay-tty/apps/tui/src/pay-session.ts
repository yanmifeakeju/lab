import type { PayableLinkEncoded, PaymentEncoded } from "@pay-tty/plane-client"
import { Clock, Data, Effect, Encoding, Match, Ref, Result, Schema, SubscriptionRef } from "effect"
import * as HttpClientError from "effect/unstable/http/HttpClientError"

import { belowWholeUnit, Parsed, parseAmount } from "./money.ts"
import { Plane } from "./plane.ts"
import type { Popup } from "./session.ts"

// A customer paying a link they hold the share token of. They have no
// account: nothing here touches a merchant session or principal.

export type Payable = PayableLinkEncoded

export type Payment = PaymentEncoded

export type Outcome = "succeeded" | "failed" | "cancelled"

export type View = Data.TaggedEnum<{
  Loading: {}
  /** No link has this token. */
  NotFound: {}
  /** The link, ready to pay unless it was deactivated. */
  Link: { readonly link: Payable }
  /** A pending payment, until an outcome is simulated or it expires. */
  Paying: { readonly link: Payable; readonly payment: Payment }
  Ended: { readonly link: Payable; readonly payment: Payment }
}>

export const View = Data.taggedEnum<View>()

export type Operation = Data.TaggedEnum<{
  Load: {}
  // The key goes with the request, so Retry can't start a second payment.
  Start: { readonly link: Payable; readonly amount: number | null; readonly key: string }
  Simulate: { readonly link: Payable; readonly payment: Payment; readonly outcome: Outcome }
}>

export const Operation = Data.taggedEnum<Operation>()

export interface State {
  readonly view: View
  readonly pending: boolean
  readonly popup: Popup<Operation> | null
}

interface ApiError {
  readonly message: string
  readonly error: { readonly code: string }
}

type Failure = ApiError | HttpClientError.HttpClientError | Schema.SchemaError

const codeOf = (failure: Failure) =>
  HttpClientError.isHttpClientError(failure) || Schema.isSchemaError(failure) ? undefined : failure.error.code

export interface Interface {
  readonly state: SubscriptionRef.SubscriptionRef<State>
  /** Loads the link, once the connection opens. */
  readonly load: Effect.Effect<void>
  /** Starts a payment of the typed amount, or the link's own when it is fixed. */
  readonly start: (amount: string) => Effect.Effect<void>
  /** Reports the outcome the customer chose for the pending payment. */
  readonly simulate: (outcome: Outcome) => Effect.Effect<void>
  /** Ends the pending payment as expired once its window has passed. */
  readonly expire: Effect.Effect<void>
  /** Back to the link after a payment that didn't succeed. */
  readonly tryAgain: Effect.Effect<void>
  readonly retry: Effect.Effect<void>
  readonly close: Effect.Effect<void>
}

const ended = (payment: Payment, status: Payment["status"]): Payment => ({ ...payment, status })

// The amount this link charges for what was typed, or why it can't.
const amountFor = (link: Payable, typed: string): Result.Result<number | null, string> => {
  const { pricing } = link

  if (pricing.mode === "fixed") {
    return Result.succeed(null)
  }

  return Parsed.$match(parseAmount(typed, link.scale), {
    Blank: () => Result.fail("Enter the amount to pay."),
    Invalid: ({ reason }) => Result.fail(reason),
    Amount: ({ minor }): Result.Result<number | null, string> => {
      const below = belowWholeUnit(minor, link.scale, link.currency_code)

      if (below !== undefined) {
        return Result.fail(`The amount ${below}.`)
      }

      if (pricing.minimum_amount !== null && minor < pricing.minimum_amount) {
        return Result.fail("The amount is below this link's minimum.")
      }

      if (pricing.maximum_amount !== null && minor > pricing.maximum_amount) {
        return Result.fail("The amount is above this link's maximum.")
      }

      return Result.succeed(minor)
    },
  })
}

const popupFor = (operation: Operation, failure: Failure): Popup<Operation> => {
  const code = codeOf(failure)

  return Operation.$match(operation, {
    Load: () => ({ message: "Couldn't load this payment link.", retry: operation, close: null }),
    Start: () =>
      Match.value(code).pipe(
        Match.when("link_inactive", () => ({
          message: "This link is no longer accepting payments.",
          retry: null,
          close: "refresh" as const,
        })),
        Match.when("validation_error", () => ({
          message: "Plane refused the amount. Check it and try again.",
          retry: null,
          close: "dismiss" as const,
        })),
        Match.when("conflict", () => ({
          message: "That request was already used for a different payment. Press Enter to start a new one.",
          retry: null,
          close: "dismiss" as const,
        })),
        Match.orElse(() => ({ message: "Couldn't start the payment.", retry: operation, close: "dismiss" as const })),
      ),
    // Close reloads the link: the payment can't be ended twice.
    Simulate: () =>
      Match.value(code).pipe(
        Match.when("not_pending", () => ({
          message: "This payment has already ended.",
          retry: null,
          close: "refresh" as const,
        })),
        Match.orElse(() => ({ message: "Couldn't report the outcome.", retry: operation, close: "dismiss" as const })),
      ),
  })
}

// Refusals that settle a start: nothing was started under its key.
const settles = (failure: Failure) => {
  const code = codeOf(failure)

  return code === "validation_error" || code === "conflict" || code === "link_inactive" || code === "not_found"
}

const idempotencyKey = Effect.sync(() => Encoding.encodeBase64Url(crypto.getRandomValues(new Uint8Array(16))))

interface Submission {
  readonly amount: number | null
  readonly key: string
}

/** One customer connection's session, for the share token they connected with. */
export const make = Effect.fnUntraced(function* (shareToken: string) {
  const plane = yield* Plane.Service

  const state = yield* SubscriptionRef.make<State>({ view: View.Loading(), pending: false, popup: null })

  // The last start whose outcome is unknown, so pressing Pay again for the
  // same amount can't start a second payment.
  const unresolved = yield* Ref.make<Submission | undefined>(undefined)

  const succeed = (view: View) => SubscriptionRef.set(state, { view, pending: false, popup: null })

  const perform = (operation: Operation): Effect.Effect<void> =>
    Effect.gen(function* () {
      const outcome = yield* Effect.result(
        Operation.$match(operation, {
          Load: () =>
            Effect.map(plane.pay.paymentLink(shareToken), (link) => View.Link({ link })),
          Start: ({ link, amount, key }) =>
            Effect.map(
              plane.pay.startPayment(shareToken, {
                params: { "idempotency-key": key },
                payload: amount === null ? {} : { amount: amount },
              }),
              // A repeat of a key may find the payment already ended.
              (payment) =>
                payment.status === "pending" ? View.Paying({ link, payment }) : View.Ended({ link, payment }),
            ),
          Simulate: ({ link, payment, outcome: chosen }) =>
            Effect.map(
              plane.pay.simulatePayment(shareToken, payment.id, { payload: { outcome: chosen } }),
              (result) => View.Ended({ link, payment: result }),
            ),
        }),
      )

      if (Operation.$is("Start")(operation) && (Result.isSuccess(outcome) || settles(outcome.failure))) {
        yield* Ref.set(unresolved, undefined)
      }

      if (Result.isSuccess(outcome)) {
        return yield* succeed(outcome.success)
      }

      const code = codeOf(outcome.failure)

      // A token that finds nothing has nothing to retry.
      if (code === "not_found") {
        return yield* succeed(View.NotFound())
      }

      if (code === "payment_expired" && Operation.$is("Simulate")(operation)) {
        return yield* succeed(View.Ended({ link: operation.link, payment: ended(operation.payment, "expired") }))
      }

      yield* Effect.logWarning(`pay ${operation._tag} failed`, outcome.failure)

      yield* SubscriptionRef.update(state, (current) => ({
        view: current.view,
        pending: false,
        popup: popupFor(operation, outcome.failure),
      }))
    })

  const begin = (allowed: (current: State) => boolean, next: (current: State) => State) =>
    SubscriptionRef.modify(state, (current) =>
      allowed(current) && !current.pending ? ([true, next(current)] as const) : ([false, current] as const),
    )

  const pending = (current: State) => ({ ...current, pending: true })

  const load = Effect.gen(function* () {
    if (yield* begin(() => true, () => ({ view: View.Loading(), pending: true, popup: null }))) {
      yield* perform(Operation.Load())
    }
  })

  const start = Effect.fnUntraced(function* (typed: string) {
    const current = yield* SubscriptionRef.get(state)

    if (!View.$is("Link")(current.view) || !current.view.link.active || current.popup !== null) {
      return
    }

    const { link } = current.view
    const amount = amountFor(link, typed)
    const showing = (now: State) => View.$is("Link")(now.view) && now.popup === null

    if (Result.isFailure(amount)) {
      return yield* begin(showing, (now) => ({
        ...now,
        popup: { message: amount.failure, retry: null, close: "dismiss" },
      }))
    }

    if (!(yield* begin(showing, pending))) {
      return
    }

    const fresh = yield* idempotencyKey

    const key = yield* Ref.modify(unresolved, (held) =>
      held !== undefined && held.amount === amount.success
        ? ([held.key, held] as const)
        : ([fresh, { amount: amount.success, key: fresh }] as const),
    )

    yield* perform(Operation.Start({ link, amount: amount.success, key }))
  })

  const simulate = Effect.fnUntraced(function* (outcome: Outcome) {
    const current = yield* SubscriptionRef.get(state)

    if (!View.$is("Paying")(current.view)) {
      return
    }

    const { link, payment } = current.view

    if (yield* begin((now) => View.$is("Paying")(now.view) && now.popup === null, pending)) {
      yield* perform(Operation.Simulate({ link, payment, outcome }))
    }
  })

  // Plane expires it too, on the next request that reaches it; this keeps the
  // screen from offering outcomes after the window.
  const expire = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis

    yield* SubscriptionRef.update(state, (current) =>
      View.$is("Paying")(current.view) && !current.pending && Date.parse(current.view.payment.expires_at) <= now
        ? {
            view: View.Ended({ link: current.view.link, payment: ended(current.view.payment, "expired") }),
            pending: false,
            popup: null,
          }
        : current,
    )
  })

  const tryAgain = Effect.asVoid(
    begin(
      (current) =>
        View.$is("Ended")(current.view) && current.view.payment.status !== "succeeded" && current.popup === null,
      (current) => (View.$is("Ended")(current.view) ? { ...current, view: View.Link({ link: current.view.link }) } : current),
    ),
  )

  const retry = Effect.gen(function* () {
    const operation = yield* SubscriptionRef.modify(state, (current) =>
      current.popup?.retry != null && !current.pending
        ? ([current.popup.retry, { ...current, pending: true }] as const)
        : ([undefined, current] as const),
    )

    if (operation !== undefined) {
      yield* perform(operation)
    }
  })

  const close = Effect.gen(function* () {
    const refresh = yield* SubscriptionRef.modify(state, (current) => {
      if (current.popup?.close == null || current.pending) {
        return [false, current] as const
      }

      return current.popup.close === "refresh"
        ? ([true, { view: View.Loading(), pending: true, popup: null }] as const)
        : ([false, { ...current, popup: null }] as const)
    })

    if (refresh) {
      yield* perform(Operation.Load())
    }
  })

  return { state, load, start, simulate, expire, tryAgain, retry, close } satisfies Interface
})

export * as PaySession from "./pay-session.ts"
