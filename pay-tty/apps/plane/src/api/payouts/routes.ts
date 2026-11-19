import { Payouts } from "@pay-tty/core/payouts"
import { Schema } from "effect"
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint"
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup"

import { inLedgerMinorUnits, LedgerAmount } from "../amounts.ts"
import { Conflict, InvalidRequestError, NotFound } from "../errors.ts"
import { Authentication } from "../middleware/authentication.ts"
import { BusinessContext } from "../middleware/business.ts"

// No name: the account holder is the business, so its name is used.
export class DestinationRequest extends Schema.Class<DestinationRequest>("PayoutDestinationRequest")({
  bank_code: Payouts.BankCode,
  account_number: Payouts.AccountNumber,
}) {}

// Replaces both; a destination is always required, so saved settings are
// always ones a payout can be sent to.
export class PayoutSettingsRequest extends Schema.Class<PayoutSettingsRequest>("PayoutSettingsRequest")({
  mode: Payouts.Mode,
  destination: DestinationRequest,
}) {}

export class Bank extends Schema.Class<Bank>("PayoutBank")({
  code: Schema.String,
  name: Schema.String,
}) {}

export class Destination extends Schema.Class<Destination>("PayoutDestination")({
  bank_code: Schema.String,
  bank_name: Schema.String,
  account_number: Schema.String,
  account_name: Schema.String,
}) {}

export class PayoutSettings extends Schema.Class<PayoutSettings>("PayoutSettings")({
  ledger: Schema.String,
  currency: Schema.String,
  scale: Schema.Int,
  // The least a payout moves, in the ledger's minor units.
  minimum: Schema.String,
  mode: Payouts.Mode,
  // Null until one is saved.
  destination: Schema.NullOr(Destination),
  // Null until the settings are first saved.
  updated_at: Schema.NullOr(Schema.String),
}) {}

// The banks a payout account can be at, for the ledger's currency.
export class BankList extends Schema.Class<BankList>("PayoutBankList")({
  banks: Schema.Array(Bank),
}) {}

export const bankList = (banks: ReadonlyArray<{ readonly code: string; readonly name: string }>) =>
  new BankList({ banks: banks.map((bank) => new Bank(bank)) })

// Amount only: the payout goes to the destination saved when it's created.
export class PayoutRequest extends Schema.Class<PayoutRequest>("PayoutRequest")({
  amount: LedgerAmount,
}) {}

const payoutFields = {
  id: Schema.String,
  ledger: Schema.String,
  currency: Schema.String,
  scale: Schema.Int,
  amount: Schema.String.annotate(inLedgerMinorUnits),
  trigger: Payouts.Trigger,
  status: Payouts.Status,
  // Why it was rejected, when the business can act on it; null for any other
  // refusal, which rejects it too unless the ledger may hold an entry for it.
  reason: Schema.NullOr(Payouts.Reason),
  // As it was when created; confirming pays this one.
  destination: Destination,
  // The ledger's entry for this payout, once recorded: its hold, or on an
  // `attention` payout one the ledger may have recorded wrongly.
  journal_ref: Schema.NullOr(Schema.String),
  // The ledger refused to capture or void the hold, or resolved it the other
  // way; no other payout is taken until support corrects it.
  ledger_mismatch: Schema.Boolean,
  created_at: Schema.String,
  // When a created payout expires unconfirmed; null once it isn't created.
  expires_at: Schema.NullOr(Schema.String),
  sent_at: Schema.NullOr(Schema.String),
  completed_at: Schema.NullOr(Schema.String),
}

/** A payout as it stands, or a repeat of a confirm already accepted. */
export class Payout extends Schema.Class<Payout>("Payout")(payoutFields) {}

/** Created: nothing moves until it is confirmed, and it expires if it isn't in time. */
export class CreatedPayout extends Schema.Class<CreatedPayout>("CreatedPayout")(payoutFields, {
  httpApiStatus: 201,
}) {}

/** Confirmed: the ledger hasn't held the money yet. */
export class ConfirmedPayout extends Schema.Class<ConfirmedPayout>("ConfirmedPayout")(payoutFields, {
  httpApiStatus: 202,
}) {}

export class PayoutPage extends Schema.Class<PayoutPage>("PayoutPage")({
  // Newest first.
  payouts: Schema.Array(Payout),
  next: Schema.NullOr(Schema.String),
}) {}

const destination = (saved: Payouts.Destination) =>
  new Destination({
    bank_code: saved.bankCode,
    bank_name: Payouts.bankName(saved.bankCode),
    account_number: saved.accountNumber,
    account_name: saved.accountName,
  })

export const payoutSettings = (settings: Payouts.Settings) =>
  new PayoutSettings({
    ledger: settings.ledger,
    currency: settings.currencyCode,
    scale: settings.scale,
    minimum: settings.minimum.toString(),
    mode: settings.mode,
    destination: settings.destination === null ? null : destination(settings.destination),
    updated_at: settings.updatedAt?.toISOString() ?? null,
  })

const fieldsOf = (payout: Payouts.Payout) => ({
  id: payout.id,
  ledger: payout.ledger,
  currency: payout.currencyCode,
  scale: payout.scale,
  amount: payout.amount.toString(),
  trigger: payout.trigger,
  status: payout.status,
  reason: payout.reason,
  destination: destination(payout.destination),
  journal_ref: payout.journalRef,
  ledger_mismatch: payout.ledgerMismatch,
  created_at: payout.createdAt.toISOString(),
  expires_at: payout.expiresAt?.toISOString() ?? null,
  sent_at: payout.sentAt?.toISOString() ?? null,
  completed_at: payout.completedAt?.toISOString() ?? null,
})

export const payout = (payout: Payouts.Payout) => new Payout(fieldsOf(payout))

export const createdPayout = (payout: Payouts.Payout) => new CreatedPayout(fieldsOf(payout))

export const confirmedPayout = ({ payout, confirmed }: Payouts.Confirmed) =>
  confirmed ? new ConfirmedPayout(fieldsOf(payout)) : new Payout(fieldsOf(payout))

export const payoutPage = (page: Payouts.Page) =>
  new PayoutPage({ payouts: page.payouts.map((listed) => payout(listed)), next: page.next })

// The caller's business, in its primary ledger: the only one it holds today.
export const payouts = HttpApiGroup.make("payouts")
  .add(HttpApiEndpoint.get("listBanks", "/payouts/banks", { success: BankList, error: Conflict }))
  .add(HttpApiEndpoint.get("getPayoutSettings", "/payouts/settings", {
    success: PayoutSettings,
    error: Conflict,
  }))
  .add(HttpApiEndpoint.put("changePayoutSettings", "/payouts/settings", {
    payload: PayoutSettingsRequest,
    success: PayoutSettings,
    error: [InvalidRequestError, Conflict],
  }))
  .add(HttpApiEndpoint.post("createPayout", "/payouts", {
    payload: PayoutRequest,
    success: CreatedPayout,
    error: [InvalidRequestError, Conflict],
  }))
  // Idempotent by ID: confirming again returns the payout as it stands.
  .add(HttpApiEndpoint.post("confirmPayout", "/payouts/:payout_id/confirm", {
    params: { payout_id: Schema.String },
    success: [ConfirmedPayout, Payout],
    error: [NotFound, Conflict],
  }))
  .add(HttpApiEndpoint.get("listPayouts", "/payouts", {
    query: { before: Schema.optionalKey(Payouts.Cursor) },
    success: PayoutPage,
    error: InvalidRequestError,
  }))
  .add(HttpApiEndpoint.get("getPayout", "/payouts/:payout_id", {
    params: { payout_id: Schema.String },
    success: Payout,
    error: NotFound,
  }))
  .middleware(BusinessContext)
  .middleware(Authentication)
