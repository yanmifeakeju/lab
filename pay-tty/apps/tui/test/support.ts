import {
  type BusinessInfoEncoded,
  createClient,
  CreatePaymentLinkRequestEncoded,
  type PayableLinkEncoded,
  type PaymentEncoded,
  type PaymentPageEncoded,
  type PaymentDetailEncoded,
  type PaymentSummaryEncoded,
  type PaymentLinkEncoded,
  type PaymentLinkListEncoded,
  type PaymentLinkSummaryEncoded,
  type PaymentStatsEncoded,
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
  readonly query: URLSearchParams
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
  /** An empty list unless given. */
  readonly listPaymentLinks?: (call: Call) => Reply
  readonly listPayments?: (call: Call) => Reply
  readonly getPayment?: (call: Call) => Reply
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
        query: url.searchParams,
        path: url.pathname,
        authorization: web.headers.get("authorization"),
        idempotencyKey: web.headers.get("idempotency-key"),
        body: text === "" ? null : yield* Effect.orDie(Schema.decodeEffect(Json)(text)),
      }

      calls.push(call)

      const route = Match.value(call.path).pipe(
        Match.when("/payments", () => routes.listPayments ?? (() => ({ status: 200, body: paymentPage() }))),
        Match.when((path) => path.startsWith("/payments/"), () =>
          routes.getPayment ?? ((call: Call) => ({ status: 200, body: paymentDetail(merchantPayment({ id: call.path.slice(10) })) }))),
        Match.when("/session", () => session),
        Match.when("/me", () => routes.me),
        Match.when("/business", () => routes.createBusiness),
        Match.when("/payment_links", () =>
          call.method === "GET" ? (routes.listPaymentLinks ?? (() => ({ status: 200, body: overview() }))) : routes.createPaymentLink),
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
        ? { mode: "fixed", amount: request.pricing.amount }
        : {
            mode: "customer_chooses",
            suggested_amount: request.pricing.suggested_amount ?? null,
            minimum_amount: request.pricing.minimum_amount ?? null,
            maximum_amount: request.pricing.maximum_amount ?? null,
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
  pricing: { mode: "fixed", amount: 2_500_000 },
  active: true,
  ...fields,
})

export const choosing = (bounds: Partial<{ suggested: number; minimum: number; maximum: number }> = {}) =>
  payable({
    title: "Tip jar",
    description: null,
    pricing: {
      mode: "customer_chooses",
      suggested_amount: bounds.suggested ?? null,
      minimum_amount: bounds.minimum ?? null,
      maximum_amount: bounds.maximum ?? null,
    },
  })

// A payment started now, pending for the usual window unless told otherwise.
export const paymentOf = (fields: Partial<PaymentEncoded> = {}): PaymentEncoded => {
  const now = DateTime.nowUnsafe()

  return {
    id: "pay_01K33YV8M82N9MXP4E7J6B1QWK",
    amount: 2_500_000,
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

  return { status: 201, body: { ...payment, amount: call.body.amount ?? payment.amount } }
}

// Plane's answer to a simulated outcome: the payment, ended that way.
export const simulated = (call: Call): Reply =>
  Schema.is(SimulatePaymentRequestEncoded)(call.body)
    ? {
        status: 200,
        body: paymentOf({ status: call.body.outcome, completed_at: DateTime.formatIso(DateTime.nowUnsafe()) }),
      }
    : failure(400, "validation_error")

export const noStats: PaymentStatsEncoded = {
  succeeded: 0,
  failed: 0,
  cancelled: 0,
  expired: 0,
  pending: 0,
  settling: 0,
  settled: 0,
  attention: 0,
  collected: "0",
  settling_amount: "0",
  last_paid_at: null,
}

// A listed link: a fixed one with no payments unless told otherwise.
export const summary = (fields: Partial<PaymentLinkSummaryEncoded> = {}): PaymentLinkSummaryEncoded => ({
  ...linkFor({ title: "Logo design", description: null, pricing: { mode: "fixed", amount: 2_500_000 } }),
  active: true,
  stats: noStats,
  ...fields,
})

// What GET /payment_links returns for these links, totalled.
export const overview = (
  links: ReadonlyArray<PaymentLinkSummaryEncoded> = [],
  fields: Partial<PaymentLinkListEncoded> = {},
): PaymentLinkListEncoded => ({
  links,
  link_count: links.length,
  active_link_count: links.filter((link) => link.active).length,
  totals: {
    succeeded: links.reduce((sum, link) => sum + link.stats.succeeded, 0),
    failed: links.reduce((sum, link) => sum + link.stats.failed, 0),
    cancelled: links.reduce((sum, link) => sum + link.stats.cancelled, 0),
    expired: links.reduce((sum, link) => sum + link.stats.expired, 0),
    pending: links.reduce((sum, link) => sum + link.stats.pending, 0),
    settling: links.reduce((sum, link) => sum + link.stats.settling, 0),
    settled: links.reduce((sum, link) => sum + link.stats.settled, 0),
    attention: links.reduce((sum, link) => sum + link.stats.attention, 0),
    collected: links.reduce((sum, link) => sum + BigInt(link.stats.collected), 0n).toString(),
    settling_amount: links.reduce((sum, link) => sum + BigInt(link.stats.settling_amount), 0n).toString(),
    last_paid_at: null,
  },
  ...fields,
})

export const listed = (...links: ReadonlyArray<PaymentLinkSummaryEncoded>) => (): Reply => ({
  status: 200,
  body: overview(links),
})

// Two listed links: one paid into, and an inactive one nobody has paid.
export const paid = summary({
  id: "plink_paid",
  title: "Logo design",
  stats: {
    succeeded: 2,
    failed: 1,
    cancelled: 0,
    expired: 3,
    pending: 1,
    settling: 0,
    settled: 2,
    attention: 0,
    collected: "5000000",
    settling_amount: "0",
    last_paid_at: "2026-10-19T14:02:31.000Z",
  },
})

export const tips = summary({
  id: "plink_tips",
  title: "Tips",
  pricing: { mode: "customer_chooses", suggested_amount: null, minimum_amount: null, maximum_amount: null },
  active: false,
})


// A settled payment, or in the state its status gives when it didn't succeed.
export const merchantPayment = (fields: Partial<PaymentSummaryEncoded> = {}): PaymentSummaryEncoded => {
  const status = fields.status ?? "succeeded"
  const settled = status === "succeeded"

  return {
    id: "pay_one",
    link_id: paid.id,
    business_id: active.id,
    amount: "2500000",
    currency_code: "NGN",
    scale: 2,
    status,
    state: settled ? "settled" : status,
    created_at: "2026-10-22T14:02:00.000Z",
    expires_at: "2026-10-22T14:32:00.000Z",
    completed_at: "2026-10-22T14:03:00.000Z",
    settled_at: settled ? "2026-10-22T14:03:05.000Z" : null,
    journal_ref: settled ? "jrn_one" : null,
    source: { kind: "link", id: paid.id, title: paid.title },
    ...fields,
  }
}

// What GET /payments/{id} returns: a settled payment's timeline unless told otherwise.
export const paymentDetail = (
  payment: PaymentSummaryEncoded,
  timeline: PaymentDetailEncoded["timeline"] = payment.state === "settled"
    ? [
        { kind: "paid", at: payment.completed_at ?? "" },
        { kind: "settled", at: payment.settled_at ?? "", journal_ref: payment.journal_ref ?? "" },
      ]
    : [],
): PaymentDetailEncoded => ({ payment, timeline })

export const paymentPage = (
  payments: ReadonlyArray<PaymentSummaryEncoded> = [],
  next: string | null = null,
): PaymentPageEncoded => ({ payments, next, stats: noStats })
