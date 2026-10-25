import { Payments } from "@pay-tty/core/payments"
import { Schema, SchemaTransformation } from "effect"
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint"
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup"

import { PaymentStats, stats } from "../payment-stats.ts"
import { Conflict } from "../errors.ts"
import { Authentication } from "../middleware/authentication.ts"
import { BusinessContext } from "../middleware/business.ts"

export const inMinorUnits = { description: "In minor units of the link's currency." }

// As JSON numbers: every amount is a safe integer, so none loses precision on
// the way.
export const Amount = Schema.Int.check(
  Schema.isGreaterThan(0).annotate({ expected: "a positive integer" }),
  Schema.isLessThanOrEqualTo(Number(Payments.maxAmount)).annotate({ expected: "a safe integer" }),
).annotate(inMinorUnits)

export const SavedAmount = Schema.Int.annotate(inMinorUnits)

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
  readonly suggested_amount?: number | null
  readonly minimum_amount?: number | null
  readonly maximum_amount?: number | null
}): Payments.Bounds => ({
  suggestedAmount: setting(pricing.suggested_amount),
  minimumAmount: setting(pricing.minimum_amount),
  maximumAmount: setting(pricing.maximum_amount),
})

export class FixedPricingRequest extends Schema.Class<FixedPricingRequest>("FixedPricingRequest")({
  mode: Schema.Literal("fixed"),
  amount: Amount,
  suggested_amount: Absent,
  minimum_amount: Absent,
  maximum_amount: Absent,
}) {}

// Omitted and null settings are the same: unset.
export class CustomerChoosesPricingRequest extends Schema.Class<CustomerChoosesPricingRequest>(
  "CustomerChoosesPricingRequest",
)(
  Schema.Struct({
    mode: Schema.Literal("customer_chooses"),
    amount: Absent,
    suggested_amount: Schema.optionalKey(Schema.NullOr(Amount)),
    minimum_amount: Schema.optionalKey(Schema.NullOr(Amount)),
    maximum_amount: Schema.optionalKey(Schema.NullOr(Amount)),
  }).check(
    Schema.makeFilter((pricing) => {
      const violation = Payments.boundsViolation(bounds(pricing))

      return violation === undefined
        ? undefined
        : { path: [`${violation.setting}_amount`], issue: violation.message }
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
  amount: SavedAmount,
}) {}

// Null for a setting the merchant left unset.
export class CustomerChoosesPricing extends Schema.Class<CustomerChoosesPricing>("CustomerChoosesPricing")({
  mode: Schema.Literal("customer_chooses"),
  suggested_amount: Schema.NullOr(SavedAmount),
  minimum_amount: Schema.NullOr(SavedAmount),
  maximum_amount: Schema.NullOr(SavedAmount),
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
    ? new FixedPricing({ mode: "fixed", amount: Number(pricing.amount) })
    : new CustomerChoosesPricing({
        mode: "customer_chooses",
        suggested_amount: amount(pricing.suggestedAmount),
        minimum_amount: amount(pricing.minimumAmount),
        maximum_amount: amount(pricing.maximumAmount),
      })

const fieldsOf = (link: Payments.Link) => ({
  id: link.id,
  business_id: link.businessId,
  title: link.title,
  description: link.description,
  currency_code: link.currencyCode,
  scale: link.scale,
  pricing: pricing(link.pricing),
  share_token: link.shareToken,
  created_at: link.createdAt.toISOString(),
})

export const paymentLink = (link: Payments.Link, created: boolean) =>
  created ? new CreatedPaymentLink(fieldsOf(link)) : new PaymentLink(fieldsOf(link))

export class PaymentLinkSummary extends Schema.Class<PaymentLinkSummary>("PaymentLinkSummary")({
  ...linkFields,
  // False once deactivated: it starts no new payments.
  active: Schema.Boolean,
  stats: PaymentStats,
}) {}

export class PaymentLinkList extends Schema.Class<PaymentLinkList>("PaymentLinkList")({
  // The newest links, at most Payments.linkListLimit of them.
  links: Schema.Array(PaymentLinkSummary),
  // Counts and totals over every link, listed or not.
  link_count: Schema.Int,
  active_link_count: Schema.Int,
  totals: PaymentStats,
}) {}

export const paymentLinkList = (overview: Payments.Overview) =>
  new PaymentLinkList({
    links: overview.links.map(
      (summary) =>
        new PaymentLinkSummary({
          ...fieldsOf(summary.link),
          active: summary.link.deactivatedAt === null,
          stats: stats(summary.stats),
        }),
    ),
    link_count: overview.linkCount,
    active_link_count: overview.activeLinkCount,
    totals: stats(overview.totals),
  })

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
  .add(
    // The caller's business's links, newest first, with what each collected.
    HttpApiEndpoint.get("listPaymentLinks", "/payment_links", {
      success: PaymentLinkList,
    }),
  )
  .middleware(BusinessContext)
  .middleware(Authentication)
