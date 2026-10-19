import { Payments } from "@pay-tty/core/payments"
import { Schema } from "effect"
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint"
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup"

import { Conflict, NotFound } from "../errors.ts"
import { Amount, CustomerChoosesPricing, FixedPricing, pricing } from "../payment_links/routes.ts"

// The customer's side: no merchant token, and the share token is the only
// credential. Nothing here names a business or a link reference.

/** A payment link as its customers see it. */
export class PayableLink extends Schema.Class<PayableLink>("PayableLink")({
  business_name: Schema.String,
  title: Schema.String,
  description: Schema.NullOr(Schema.String),
  currency_code: Schema.String,
  scale: Schema.Int,
  pricing: Schema.Union([FixedPricing, CustomerChoosesPricing]),
  /** False once the merchant deactivates it: it starts no new payments. */
  active: Schema.Boolean,
}) {}

export class StartPaymentRequest extends Schema.Class<StartPaymentRequest>("StartPaymentRequest")({
  // Required by a customer-chosen link and refused by a fixed one, which
  // charges its own amount; only the link can tell which.
  amount_minor: Schema.optionalKey(Schema.NullOr(Amount)),
}) {}

export class SimulatePaymentRequest extends Schema.Class<SimulatePaymentRequest>("SimulatePaymentRequest")({
  outcome: Payments.Outcome,
}) {}

const paymentFields = {
  id: Schema.String,
  amount_minor: Schema.Int,
  currency_code: Schema.String,
  scale: Schema.Int,
  status: Payments.Status,
  created_at: Schema.String,
  expires_at: Schema.String,
  // Null while pending.
  completed_at: Schema.NullOr(Schema.String),
}

/** A payment as it stands, or a repeat of a start that already succeeded. */
export class Payment extends Schema.Class<Payment>("Payment")(paymentFields) {}

export class StartedPayment extends Schema.Class<StartedPayment>("StartedPayment")(paymentFields, {
  httpApiStatus: 201,
}) {}

export const payableLink = ({ link, businessName }: Payments.Payable) =>
  new PayableLink({
    business_name: businessName,
    title: link.title,
    description: link.description,
    currency_code: link.currencyCode,
    scale: link.scale,
    pricing: pricing(link.pricing),
    active: link.deactivatedAt === null,
  })

export const payment = (payment: Payments.Payment, created = false) => {
  const fields = {
    id: payment.id,
    amount_minor: Number(payment.amountMinor),
    currency_code: payment.currencyCode,
    scale: payment.scale,
    status: payment.status,
    created_at: payment.createdAt.toISOString(),
    expires_at: payment.expiresAt.toISOString(),
    completed_at: payment.completedAt?.toISOString() ?? null,
  }

  return created ? new StartedPayment(fields) : new Payment(fields)
}

const link = { share_token: Schema.String }

export const pay = HttpApiGroup.make("pay")
  .add(
    HttpApiEndpoint.get("paymentLink", "/pay/payment_links/:share_token", {
      params: link,
      success: PayableLink,
      error: NotFound,
    }),
  )
  .add(
    // Pending until an outcome is simulated or it expires.
    HttpApiEndpoint.post("startPayment", "/pay/payment_links/:share_token/payments", {
      params: link,
      headers: { "idempotency-key": Payments.IdempotencyKey },
      payload: StartPaymentRequest,
      success: [StartedPayment, Payment],
      error: [NotFound, Conflict],
    }),
  )
  .add(
    // Stands in for a payment provider's report. Only a payment started
    // through this link's token can be reached.
    HttpApiEndpoint.post("simulatePayment", "/pay/payment_links/:share_token/payments/:payment_id/simulate", {
      params: { ...link, payment_id: Schema.String },
      payload: SimulatePaymentRequest,
      success: Payment,
      error: [NotFound, Conflict],
    }),
  )
