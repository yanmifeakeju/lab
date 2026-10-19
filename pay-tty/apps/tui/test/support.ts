import {
  type BusinessInfoEncoded,
  createClient,
  CreatePaymentLinkRequestEncoded,
  type PayableLinkEncoded,
  type PaymentEncoded,
  type PaymentLinkEncoded,
  SimulatePaymentRequestEncoded,
  StartPaymentRequestEncoded,
} from "@pay-tty/plane-client"
import { DateTime, Effect, Layer, Match, Schema } from "effect"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientError from "effect/unstable/http/HttpClientError"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"

import { Plane } from "../src/plane.ts"

export interface Call {
  readonly method: string
  readonly path: string
  readonly authorization: string | null
  readonly idempotencyKey: string | null
  readonly body: unknown
}

// "hang" never answers, so a test can see a disconnect cancel the request.
export type Reply = { readonly status: number; readonly body: object } | "unreachable" | "hang"

export interface Routes {
  readonly session?: (call: Call) => Reply
  readonly me?: (call: Call) => Reply
  readonly createBusiness?: (call: Call) => Reply
  readonly openAccount?: (call: Call) => Reply
  readonly createPaymentLink?: (call: Call) => Reply
  readonly payableLink?: (call: Call) => Reply
  readonly startPayment?: (call: Call) => Reply
  readonly simulatePayment?: (call: Call) => Reply
}

export const business = (fields: Partial<BusinessInfoEncoded> = {}): BusinessInfoEncoded => ({
  id: "biz_1",
  name: "Acme Ltd",
  country_code: "NG",
  currency_code: "NGN",
  holder_ref: null,
  status: "created",
  ledger: null,
  created_at: "2026-10-08T00:00:00.000Z",
  updated_at: "2026-10-08T00:00:00.000Z",
  ...fields,
})

export const active = business({
  status: "active",
  holder_ref: "hld_1",
  ledger: { slug: "ngn_ng", currency: "NGN", scale: 2, payable_account_ref: "acct_1" },
})

export const failure = (status: number, code: string): Reply => ({ status, body: { message: "Refused.", error: { code } } })

export const unauthorized = failure(401, "unauthorized")

// Each exchange issues a new token, so a test can see which one a call used.
export const sessions = (expiresIn = 900) => {
  let issued = 0

  return (): Reply => {
    issued += 1

    return { status: 200, body: { access_token: `tok_${issued}`, token_type: "Bearer", expires_in: expiresIn } }
  }
}

export const Json = Schema.fromJsonString(Schema.Unknown)

// Plane is the one thing faked, at the HTTP boundary, so the generated
// client's encoding and decoding still run.
export const fakePlane = (routes: Routes) => {
  const calls: Array<Call> = []
  const session = routes.session ?? sessions()

  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      const web = yield* Effect.orDie(HttpClientRequest.toWeb(request))
      const url = new URL(web.url)
      const text = yield* Effect.promise(() => web.text())

      const call: Call = {
        method: web.method,
        path: url.pathname,
        authorization: web.headers.get("authorization"),
        idempotencyKey: web.headers.get("idempotency-key"),
        body: text === "" ? null : yield* Effect.orDie(Schema.decodeEffect(Json)(text)),
      }

      calls.push(call)

      const route = Match.value(call.path).pipe(
        Match.when("/session", () => session),
        Match.when("/me", () => routes.me),
        Match.when("/business", () => routes.createBusiness),
        Match.when("/payment_links", () => routes.createPaymentLink),
        Match.when((path) => path.endsWith("/simulate"), () => routes.simulatePayment),
        Match.when((path) => path.endsWith("/payments"), () => routes.startPayment),
        Match.when((path) => path.startsWith("/pay/"), () => routes.payableLink),
        Match.orElse(() => routes.openAccount),
      )

      const reply = route?.(call) ?? { status: 404, body: {} }

      if (reply === "hang") {
        return yield* Effect.never
      }

      if (reply === "unreachable") {
        return yield* new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, description: "connection refused" }),
        })
      }

      return HttpClientResponse.fromWeb(request, Response.json(reply.body, { status: reply.status }))
    }),
  )

  return {
    calls,
    layer: Layer.succeed(Plane.Service, createClient(http, { baseUrl: "http://plane.test" })),
  }
}


// Runs a test body; node:test wants a promise.
export const scenario = <A>(body: Effect.Effect<A>) => () => Effect.runPromise(body)

export const me = (shown: BusinessInfoEncoded | null) => (): Reply => ({
  status: 200,
  body: { id: "prn_1", created_at: "2026-10-08T00:00:00.000Z", business: shown },
})

// Replies in order, then the last one for every later call.
export const inTurn = (...replies: ReadonlyArray<Reply>) => {
  const queue = [...replies]

  return (): Reply => (queue.length > 1 ? (queue.shift() ?? "unreachable") : (queue[0] ?? "unreachable"))
}


// What plane returns for a link created from this request.
export const linkFor = (
  request: CreatePaymentLinkRequestEncoded,
  fields: Partial<PaymentLinkEncoded> = {},
): PaymentLinkEncoded => ({
    id: "plink_01K33YV8M82N9MXP4E7J6B1QWK",
    business_id: "biz_1",
    title: request.title,
    description: request.description ?? null,
    currency_code: "NGN",
    scale: 2,
    pricing:
      request.pricing.mode === "fixed"
        ? { mode: "fixed", amount_minor: request.pricing.amount_minor }
        : {
            mode: "customer_chooses",
            suggested_amount_minor: request.pricing.suggested_amount_minor ?? null,
            minimum_amount_minor: request.pricing.minimum_amount_minor ?? null,
            maximum_amount_minor: request.pricing.maximum_amount_minor ?? null,
          },
    share_token: "tok",
    created_at: "2026-10-15T00:00:00.000Z",
    ...fields,
})

// Plane's answer to a creation: the link, 201 when new.
export const createdLink = (status = 201) => (call: Call): Reply =>
  Schema.is(CreatePaymentLinkRequestEncoded)(call.body)
    ? { status, body: linkFor(call.body) }
    : failure(400, "validation_error")

// These replies in order, then `rest` for every later call.
export const first = (...replies: ReadonlyArray<Reply>) => (rest: (call: Call) => Reply) => {
  const queue = [...replies]

  return (call: Call): Reply => queue.shift() ?? rest(call)
}

// The share token a customer test connects with.
export const shareToken = "s".repeat(43)

export const payable = (fields: Partial<PayableLinkEncoded> = {}): PayableLinkEncoded => ({
  business_name: "Adaeze Studio",
  title: "Logo design",
  description: "Two concepts and one revision.",
  currency_code: "NGN",
  scale: 2,
  pricing: { mode: "fixed", amount_minor: 2_500_000 },
  active: true,
  ...fields,
})

export const choosing = (bounds: Partial<{ suggested: number; minimum: number; maximum: number }> = {}) =>
  payable({
    title: "Tip jar",
    description: null,
    pricing: {
      mode: "customer_chooses",
      suggested_amount_minor: bounds.suggested ?? null,
      minimum_amount_minor: bounds.minimum ?? null,
      maximum_amount_minor: bounds.maximum ?? null,
    },
  })

// A payment started now, pending for the usual window unless told otherwise.
export const paymentOf = (fields: Partial<PaymentEncoded> = {}): PaymentEncoded => {
  const now = DateTime.nowUnsafe()

  return {
    id: "pay_01K33YV8M82N9MXP4E7J6B1QWK",
    amount_minor: 2_500_000,
    currency_code: "NGN",
    scale: 2,
    status: "pending",
    created_at: DateTime.formatIso(now),
    expires_at: DateTime.formatIso(DateTime.add(now, { minutes: 30 })),
    completed_at: null,
    ...fields,
  }
}

// Plane's answer to a start: a new pending payment of the requested amount,
// or the link's own when none was sent.
export const startedPayment = (fields: Partial<PaymentEncoded> = {}) => (call: Call): Reply => {
  if (!Schema.is(StartPaymentRequestEncoded)(call.body)) {
    return failure(400, "validation_error")
  }

  const payment = paymentOf(fields)

  return { status: 201, body: { ...payment, amount_minor: call.body.amount_minor ?? payment.amount_minor } }
}

// Plane's answer to a simulated outcome: the payment, ended that way.
export const simulated = (call: Call): Reply =>
  Schema.is(SimulatePaymentRequestEncoded)(call.body)
    ? {
        status: 200,
        body: paymentOf({ status: call.body.outcome, completed_at: DateTime.formatIso(DateTime.nowUnsafe()) }),
      }
    : failure(400, "validation_error")
