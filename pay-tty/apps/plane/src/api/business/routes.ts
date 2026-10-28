import { Business } from "@pay-tty/core/business"
import type { PayableAccounts } from "@pay-tty/core/ledger"
import { Effect, Schema, SchemaTransformation } from "effect"
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint"
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup"

import { BadGateway, Conflict, InvalidRequestError, ServiceUnavailable } from "../errors.ts"
import { Authentication } from "../middleware/authentication.ts"
import { BusinessContext } from "../middleware/business.ts"
import { Account } from "./account.ts"

// Snake case on the wire, timestamps as ISO 8601 strings; `businessInfo` maps
// core's camelCase and dates explicitly. /me, /business, and /business/account share it.

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

const inLedgerMinorUnits = { description: "In minor units of the ledger's currency." }

// The payable account's figures, in the primary ledger's currency and scale.
export class BusinessBalance extends Schema.Class<BusinessBalance>("BusinessBalance")({
  ledger: Schema.String,
  currency: Schema.String,
  scale: Schema.Int,
  // What the business can pay out: posted credits less debits, pending ones included.
  available: Schema.String.annotate(inLedgerMinorUnits),
  // Credits not yet posted.
  pending: Schema.String.annotate(inLedgerMinorUnits),
}) {}

export class StatementMovement extends Schema.Class<StatementMovement>("StatementMovement")({
  // With line_number, names the row: one entry can touch the account on two lines.
  journal_ref: Schema.String,
  line_number: Schema.Int,
  direction: Schema.Literals(["debit", "credit"]),
  amount: Schema.String.annotate(inLedgerMinorUnits),
  balance_after: Schema.String.annotate(inLedgerMinorUnits),
  description: Schema.String,
  recorded_at: Schema.String,
}) {}

// Posted movements only, so the figures are the ledger balance, not available.
export class BusinessStatement extends Schema.Class<BusinessStatement>("BusinessStatement")({
  ledger: Schema.String,
  currency: Schema.String,
  scale: Schema.Int,
  // The ledger's bounds; `to` is exclusive, a minute or more before now.
  period: Schema.Struct({ from: Schema.String, to: Schema.String }),
  // Either side of the whole period, whatever the page.
  opening: Schema.String.annotate(inLedgerMinorUnits),
  closing: Schema.String.annotate(inLedgerMinorUnits),
  // Newest first.
  movements: Schema.Array(StatementMovement),
  // Cursors to the newer and older pages, null at either end; pass one back as `cursor`.
  previous: Schema.NullOr(Schema.String),
  next: Schema.NullOr(Schema.String),
}) {}

export const businessStatement = (business: Business.Info, statement: PayableAccounts.Statement) =>
  new BusinessStatement({
    ledger: business.primaryLedger.slug,
    currency: business.primaryLedger.currency,
    scale: business.primaryLedger.scale,
    period: { from: statement.period.from.toISOString(), to: statement.period.to.toISOString() },
    opening: String(statement.opening),
    closing: String(statement.closing),
    movements: statement.movements.map((movement) =>
      new StatementMovement({
        journal_ref: movement.journalRef,
        line_number: movement.lineNumber,
        direction: movement.direction,
        amount: String(movement.amount),
        balance_after: String(movement.balanceAfter),
        description: movement.description,
        recorded_at: movement.recordedAt.toISOString(),
      })),
    previous: statement.previous,
    next: statement.next,
  })

export class CreateBusinessRequest extends Schema.Class<CreateBusinessRequest>("CreateBusinessRequest")({
  // Trimmed before the length checks, so surrounding whitespace neither counts
  // toward the limit nor reaches the ledger as part of the holder's name.
  name: Schema.String.check(
    Schema.isPattern(new RegExp(".*\\S.*")).annotate({
      expected: "a string containing non-whitespace",
    }),
  ).pipe(
    Schema.decodeTo(
      Schema.Trimmed.check(
        Schema.isMinLength(1).annotate({ expected: "a value with a length of at least 1" }),
        Schema.isMaxLength(255).annotate({ expected: "a value with a length of at most 255" }),
      ),
      SchemaTransformation.trim(),
    ),
  ),
  // Only an absent key defaults; null or an unlisted code is refused.
  country_code: Business.Country.annotate({ default: "NG" }).pipe(Schema.withDecodingDefaultKey(Effect.succeed("NG"))),
}) {}

export const business = HttpApiGroup.make("business")
  .add(
    HttpApiEndpoint.post("createBusiness", "/business", {
      payload: CreateBusinessRequest,
      success: BusinessInfo,
      error: [Conflict, ServiceUnavailable],
    }),
  )
  .add(
    // No body: the account opens in the ledger saved when the business was
    // created. Only this route needs the caller to have a business already.
    HttpApiEndpoint.post("createAccount", "/business/account", {
      success: BusinessInfo,
      error: [Conflict, BadGateway, ServiceUnavailable],
    }).middleware(BusinessContext),
  )
  .add(
    // The caller's business, read from the ledger on every request.
    HttpApiEndpoint.get("getBalance", "/business/balance", {
      success: BusinessBalance,
      error: [Conflict, BadGateway, ServiceUnavailable],
    }).middleware(BusinessContext),
  )
  .add(
    // The caller's business, newest first. A cursor keeps its own period, so
    // `period` is ignored beside one.
    HttpApiEndpoint.get("getStatement", "/business/statement", {
      query: {
        period: Schema.optionalKey(Account.Period.annotate({ default: Account.defaultPeriod })),
        cursor: Schema.optionalKey(Schema.String),
      },
      success: BusinessStatement,
      error: [InvalidRequestError, Conflict, BadGateway, ServiceUnavailable],
    }).middleware(BusinessContext),
  )
  .middleware(Authentication)
