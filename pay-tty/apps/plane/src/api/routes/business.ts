import { Business } from "@pay-tty/core/business"
import { Effect, Schema } from "effect"
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint"
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup"

import { BadGateway, Conflict, NotFound, ServiceUnavailable } from "../errors.ts"
import { Authentication } from "./middleware.ts"

// Snake case on the wire, timestamps as ISO 8601 strings; `businessInfo` maps
// core's camelCase and dates explicitly. /me and /business share it.

export class BusinessLedger extends Schema.Class<BusinessLedger>("BusinessLedger")({
  slug: Schema.String,
  currency: Schema.String,
  scale: Schema.Int,
  payable_account_ref: Schema.String,
}) {}

export class BusinessInfo extends Schema.Class<BusinessInfo>("BusinessInfo")({
  id: Schema.String,
  name: Schema.String,
  country_code: Business.Country,
  // Derived from the country by the server; the ledger's currency matches.
  currency_code: Schema.String,
  holder_ref: Schema.NullOr(Schema.String),
  status: Business.Status,
  // The completed primary ledger; null until its account is recorded.
  ledger: Schema.NullOr(BusinessLedger),
  created_at: Schema.String,
  updated_at: Schema.String,
}) {}

export const businessInfo = (business: Business.Info) =>
  new BusinessInfo({
    id: business.id,
    name: business.name,
    country_code: business.countryCode,
    currency_code: business.currencyCode,
    holder_ref: business.holderRef,
    status: business.status,
    ledger:
      business.primaryLedger.payableAccountRef === null
        ? null
        : new BusinessLedger({
            slug: business.primaryLedger.slug,
            currency: business.primaryLedger.currency,
            scale: business.primaryLedger.scale,
            payable_account_ref: business.primaryLedger.payableAccountRef,
          }),
    created_at: business.createdAt.toISOString(),
    updated_at: business.updatedAt.toISOString(),
  })

export class CreateBusinessRequest extends Schema.Class<CreateBusinessRequest>("CreateBusinessRequest")({
  name: Schema.String.check(
    Schema.isMinLength(1).annotate({ expected: "a value with a length of at least 1" }),
    Schema.isMaxLength(255).annotate({ expected: "a value with a length of at most 255" }),
    Schema.isPattern(new RegExp(".*\\S.*")).annotate({
      expected: "a string containing non-whitespace",
    }),
  ),
  // Only an absent key defaults; null or an unlisted code is refused.
  country_code: Business.Country.annotate({ default: "NG" }).pipe(Schema.withDecodingDefaultKey(Effect.succeed("NG"))),
}) {}

export const business = HttpApiGroup.make("business")
  .add(
    HttpApiEndpoint.post("createBusiness", "/business", {
      payload: CreateBusinessRequest,
      success: BusinessInfo,
      error: ServiceUnavailable,
    }),
  )
  .add(
    // No body: the ledger is the one saved when the business was created.
    HttpApiEndpoint.post("createBusinessLedger", "/business/:businessId/ledger", {
      params: { businessId: Schema.String },
      success: BusinessInfo,
      error: [NotFound, Conflict, BadGateway, ServiceUnavailable],
    }),
  )
  .middleware(Authentication)
