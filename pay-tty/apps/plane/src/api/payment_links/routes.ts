import { Payments } from "@pay-tty/core/payments"
import { Schema, SchemaTransformation } from "effect"
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint"
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup"

import { Conflict } from "../errors.ts"
import { Authentication } from "../middleware/authentication.ts"
import { BusinessContext } from "../middleware/business.ts"

// Minor units at the business's scale, as JSON numbers: every one is a safe
// integer, so none loses precision on the way.
export const Amount = Schema.Int.check(
  Schema.isGreaterThan(0).annotate({ expected: "a positive integer" }),
  Schema.isLessThanOrEqualTo(Number(Payments.maxAmount)).annotate({ expected: "a safe integer" }),
)

// Settings of the other mode are refused, not dropped: a merchant who sent one
// meant something this link wouldn't do.
const Absent = Schema.optionalKey(Schema.Never.annotate({ expected: "absent in this pricing mode" }))

// Trimmed before the length checks, so surrounding whitespace doesn't count.
const trimmed = (max: number) =>
  Schema.String.pipe(
    Schema.decodeTo(
      Schema.Trimmed.check(
        Schema.isMaxLength(max).annotate({ expected: `a value with a length of at most ${max}` }),
      ),
      SchemaTransformation.trim(),
    ),
  )

const setting = (amount: number | null | undefined) => (amount == null ? null : BigInt(amount))

export const bounds = (pricing: {
  readonly suggested_amount_minor?: number | null
  readonly minimum_amount_minor?: number | null
  readonly maximum_amount_minor?: number | null
}): Payments.Bounds => ({
  suggestedAmountMinor: setting(pricing.suggested_amount_minor),
  minimumAmountMinor: setting(pricing.minimum_amount_minor),
  maximumAmountMinor: setting(pricing.maximum_amount_minor),
})

export class FixedPricingRequest extends Schema.Class<FixedPricingRequest>("FixedPricingRequest")({
  mode: Schema.Literal("fixed"),
  amount_minor: Amount,
  suggested_amount_minor: Absent,
  minimum_amount_minor: Absent,
  maximum_amount_minor: Absent,
}) {}

// Omitted and null settings are the same: unset.
export class CustomerChoosesPricingRequest extends Schema.Class<CustomerChoosesPricingRequest>(
  "CustomerChoosesPricingRequest",
)(
  Schema.Struct({
    mode: Schema.Literal("customer_chooses"),
    amount_minor: Absent,
    suggested_amount_minor: Schema.optionalKey(Schema.NullOr(Amount)),
    minimum_amount_minor: Schema.optionalKey(Schema.NullOr(Amount)),
    maximum_amount_minor: Schema.optionalKey(Schema.NullOr(Amount)),
  }).check(
    Schema.makeFilter((pricing) => {
      const violation = Payments.boundsViolation(bounds(pricing))

      return violation === undefined
        ? undefined
        : { path: [`${violation.setting}_amount_minor`], issue: violation.message }
    }),
  ),
) {}

export class CreatePaymentLinkRequest extends Schema.Class<CreatePaymentLinkRequest>("CreatePaymentLinkRequest")({
  title: Schema.String.check(
    Schema.isPattern(new RegExp(".*\\S.*")).annotate({ expected: "a string containing non-whitespace" }),
  ).pipe(Schema.decodeTo(Schema.Trimmed.check(Schema.isMinLength(1), Schema.isMaxLength(255)), SchemaTransformation.trim())),
  // Omitted, null, and blank all mean no description.
  description: Schema.optionalKey(Schema.NullOr(trimmed(500))),
  pricing: Schema.Union([FixedPricingRequest, CustomerChoosesPricingRequest]),
}) {}

export class FixedPricing extends Schema.Class<FixedPricing>("FixedPricing")({
  mode: Schema.Literal("fixed"),
  amount_minor: Schema.Int,
}) {}

// Null for a setting the merchant left unset.
export class CustomerChoosesPricing extends Schema.Class<CustomerChoosesPricing>("CustomerChoosesPricing")({
  mode: Schema.Literal("customer_chooses"),
  suggested_amount_minor: Schema.NullOr(Schema.Int),
  minimum_amount_minor: Schema.NullOr(Schema.Int),
  maximum_amount_minor: Schema.NullOr(Schema.Int),
}) {}

const linkFields = {
  id: Schema.String,
  business_id: Schema.String,
  title: Schema.String,
  description: Schema.NullOr(Schema.String),
  currency_code: Schema.String,
  scale: Schema.Int,
  pricing: Schema.Union([FixedPricing, CustomerChoosesPricing]),
  // What customers pay the link by: the user name in `ssh <token>@host`.
  share_token: Schema.String,
  created_at: Schema.String,
}

/** A repeat of a creation that already succeeded. */
export class PaymentLink extends Schema.Class<PaymentLink>("PaymentLink")(linkFields) {}

export class CreatedPaymentLink extends Schema.Class<CreatedPaymentLink>("CreatedPaymentLink")(linkFields, {
  httpApiStatus: 201,
}) {}

const amount = (minor: bigint | null) => (minor === null ? null : Number(minor))

export const pricing = (pricing: Payments.Pricing) =>
  pricing.mode === "fixed"
    ? new FixedPricing({ mode: "fixed", amount_minor: Number(pricing.amountMinor) })
    : new CustomerChoosesPricing({
        mode: "customer_chooses",
        suggested_amount_minor: amount(pricing.suggestedAmountMinor),
        minimum_amount_minor: amount(pricing.minimumAmountMinor),
        maximum_amount_minor: amount(pricing.maximumAmountMinor),
      })

export const paymentLink = (link: Payments.Link, created: boolean) => {
  const fields = {
    id: link.id,
    business_id: link.businessId,
    title: link.title,
    description: link.description,
    currency_code: link.currencyCode,
    scale: link.scale,
    pricing: pricing(link.pricing),
    share_token: link.shareToken,
    created_at: link.createdAt.toISOString(),
  }

  return created ? new CreatedPaymentLink(fields) : new PaymentLink(fields)
}

export const paymentLinks = HttpApiGroup.make("paymentLinks")
  .add(
    // For the caller's business. Plane resolves the currency, scale, and URL;
    // the caller supplies none.
    HttpApiEndpoint.post("createPaymentLink", "/payment_links", {
      headers: { "idempotency-key": Payments.IdempotencyKey },
      payload: CreatePaymentLinkRequest,
      success: [CreatedPaymentLink, PaymentLink],
      error: Conflict,
    }),
  )
  .middleware(BusinessContext)
  .middleware(Authentication)
