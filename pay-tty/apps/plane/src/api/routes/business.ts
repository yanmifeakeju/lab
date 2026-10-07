import { Business } from "@pay-tty/core/business"
import { Schema } from "effect"
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
  // Assigned by the server; the default ledger's currency always matches.
  currency_code: Schema.String,
  holder_ref: Schema.NullOr(Schema.String),
  status: Business.Status,
  // The completed default ledger; null until its account is recorded.
  ledger: Schema.NullOr(BusinessLedger),
  created_at: Schema.String,
  updated_at: Schema.String,
}) {}

export const businessInfo = (business: Business.Info) =>
  new BusinessInfo({
    id: business.id,
    name: business.name,
    currency_code: business.currencyCode,
    holder_ref: business.holderRef,
    status: business.status,
    ledger:
      business.ledger === null
        ? null
        : new BusinessLedger({
            slug: business.ledger.slug,
            currency: business.ledger.currency,
            scale: business.ledger.scale,
            payable_account_ref: business.ledger.payableAccountRef,
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
}) {}

export const business = HttpApiGroup.make("business")
  .add(
    HttpApiEndpoint.post("createBusiness", "/business", {
      payload: CreateBusinessRequest,
      success: BusinessInfo,
    }),
  )
  .add(
    // No body: the ledger and currency are the server's, not the caller's.
    HttpApiEndpoint.post("createBusinessLedger", "/business/:businessId/ledger", {
      params: { businessId: Schema.String },
      success: BusinessInfo,
      error: [NotFound, Conflict, BadGateway, ServiceUnavailable],
    }),
  )
  .middleware(Authentication)
