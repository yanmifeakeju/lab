import { Payments } from "@pay-tty/core/payments"
import { Match, Schema } from "effect"
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint"
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup"

import { InvalidRequestError, NotFound } from "../errors.ts"
import { Authentication } from "../middleware/authentication.ts"
import { BusinessContext } from "../middleware/business.ts"
import { inMinorUnits } from "../payment_links/routes.ts"
import { PaymentStats, stats } from "../payment-stats.ts"

export class PaymentSummary extends Schema.Class<PaymentSummary>("PaymentSummary")({
  id: Schema.String,
  link_id: Schema.String,
  business_id: Schema.String,
  amount: Schema.String.annotate(inMinorUnits),
  currency_code: Schema.String,
  scale: Schema.Int,
  status: Payments.Status,
  // Its status until it succeeds, then how its ledger posting stands.
  state: Payments.State,
  created_at: Schema.String,
  expires_at: Schema.String,
  completed_at: Schema.NullOr(Schema.String),
  // Set once the ledger has posted it.
  settled_at: Schema.NullOr(Schema.String),
  journal_ref: Schema.NullOr(Schema.String),
  source: Schema.Union([
    Schema.Struct({ kind: Schema.tag("link"), id: Schema.String, title: Schema.String }),
  ]),
}) {}

export class PaymentPage extends Schema.Class<PaymentPage>("PaymentPage")({
  payments: Schema.Array(PaymentSummary),
  stats: PaymentStats,
  next: Schema.NullOr(Schema.String),
}) {}

export class PaidEvent extends Schema.Class<PaidEvent>("PaidEvent")({
  kind: Schema.tag("paid"),
  at: Schema.String,
}) {}

export class SettledEvent extends Schema.Class<SettledEvent>("SettledEvent")({
  kind: Schema.tag("settled"),
  at: Schema.String,
  journal_ref: Schema.String,
}) {}

// The ledger won't take the posting; at is its last attempt.
export class RefusedEvent extends Schema.Class<RefusedEvent>("RefusedEvent")({
  kind: Schema.tag("refused"),
  at: Schema.String,
  error_code: Schema.String,
}) {}

export class PaymentDetail extends Schema.Class<PaymentDetail>("PaymentDetail")({
  payment: PaymentSummary,
  // Oldest first.
  timeline: Schema.Array(Schema.Union([PaidEvent, SettledEvent, RefusedEvent])),
}) {}

const paymentSummary = (payment: Payments.PaymentSummary) => new PaymentSummary({
  id: payment.id,
  link_id: payment.linkId,
  business_id: payment.businessId,
  amount: payment.amount.toString(),
  currency_code: payment.currencyCode,
  scale: payment.scale,
  status: payment.status,
  state: payment.state,
  created_at: payment.createdAt.toISOString(),
  expires_at: payment.expiresAt.toISOString(),
  completed_at: payment.completedAt?.toISOString() ?? null,
  settled_at: payment.settledAt?.toISOString() ?? null,
  journal_ref: payment.journalRef,
  source: payment.source,
})

export const paymentPage = (page: Payments.PaymentPage) => new PaymentPage({
  payments: page.payments.map(paymentSummary),
  stats: stats(page.stats),
  next: page.next,
})

const event = Match.type<Payments.Event>().pipe(
  Match.tagsExhaustive({
    paid: ({ at }) => new PaidEvent({ at: at.toISOString() }),
    settled: ({ at, journalRef }) => new SettledEvent({ at: at.toISOString(), journal_ref: journalRef }),
    refused: ({ at, errorCode }) => new RefusedEvent({ at: at.toISOString(), error_code: errorCode }),
  }),
)

export const paymentDetail = (detail: Payments.PaymentDetail) => new PaymentDetail({
  payment: paymentSummary(detail.payment),
  timeline: detail.timeline.map(event),
})

export const payments = HttpApiGroup.make("payments")
  .add(HttpApiEndpoint.get("listPayments", "/payments", {
    query: {
      link_id: Schema.optionalKey(Schema.String),
      state: Schema.optionalKey(Payments.State),
      before: Schema.optionalKey(Payments.Cursor),
    },
    success: PaymentPage,
    error: [NotFound, InvalidRequestError],
  }))
  .add(HttpApiEndpoint.get("getPayment", "/payments/:payment_id", {
    params: { payment_id: Schema.String },
    success: PaymentDetail,
    error: NotFound,
  }))
  .middleware(BusinessContext)
  .middleware(Authentication)
