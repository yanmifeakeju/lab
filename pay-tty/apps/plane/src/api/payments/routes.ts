import { Payments } from "@pay-tty/core/payments"
import { Schema } from "effect"
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint"
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup"

import { InvalidRequestError, NotFound } from "../errors.ts"
import { Authentication } from "../middleware/authentication.ts"
import { BusinessContext } from "../middleware/business.ts"
import { PaymentStats, stats } from "../payment-stats.ts"

export class PaymentSummary extends Schema.Class<PaymentSummary>("PaymentSummary")({
  id: Schema.String,
  link_id: Schema.String,
  business_id: Schema.String,
  amount_minor: Schema.String,
  currency_code: Schema.String,
  scale: Schema.Int,
  status: Payments.Status,
  created_at: Schema.String,
  expires_at: Schema.String,
  completed_at: Schema.NullOr(Schema.String),
  source: Schema.Union([
    Schema.Struct({ kind: Schema.tag("link"), id: Schema.String, title: Schema.String }),
  ]),
}) {}

export class PaymentPage extends Schema.Class<PaymentPage>("PaymentPage")({
  payments: Schema.Array(PaymentSummary),
  stats: PaymentStats,
  next: Schema.NullOr(Schema.String),
}) {}

export const paymentPage = (page: Payments.PaymentPage) => new PaymentPage({
  payments: page.payments.map((payment) => new PaymentSummary({
    id: payment.id,
    link_id: payment.linkId,
    business_id: payment.businessId,
    amount_minor: payment.amountMinor.toString(),
    currency_code: payment.currencyCode,
    scale: payment.scale,
    status: payment.status,
    created_at: payment.createdAt.toISOString(),
    expires_at: payment.expiresAt.toISOString(),
    completed_at: payment.completedAt?.toISOString() ?? null,
    source: payment.source,
  })),
  stats: stats(page.stats),
  next: page.next,
})

export const payments = HttpApiGroup.make("payments")
  .add(HttpApiEndpoint.get("listPayments", "/payments", {
    query: {
      link_id: Schema.optionalKey(Schema.String),
      status: Schema.optionalKey(Payments.Status),
      before: Schema.optionalKey(Payments.Cursor),
    },
    success: PaymentPage,
    error: [NotFound, InvalidRequestError],
  }))
  .middleware(BusinessContext)
  .middleware(Authentication)
