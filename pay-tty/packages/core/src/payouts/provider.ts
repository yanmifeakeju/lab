import { Context, Schema } from "effect"
import type { Effect } from "effect"

import { Ledger } from "../ledger/slug.ts"
import { Destination, ID, Outcome } from "./payouts.ts"

/** The provider's reference for a payout: never blank. */
export const ProviderRef = Schema.String.pipe(Schema.check(Schema.isPattern(/\S/)), Schema.brand("PayoutProvider.ProviderRef"))

export type ProviderRef = typeof ProviderRef.Type

/** A held payout transfer to be sent to its destination bank account. */
export class Transfer extends Schema.Class<Transfer>("PayoutProvider.Transfer")({
  payoutId: ID,
  /** Ledger slug identifying the source account for this payout. */
  ledger: Ledger.Slug,
  currencyCode: Schema.String,
  amount: Schema.BigInt,
  destination: Destination,
  /** Provider reference, or null when a previous send response was lost. */
  providerRef: Schema.NullOr(Schema.String),
}) {}

/**
 * Status of an unreported transfer when polled. The check is a lookup by our
 * reference, so a final answer carries the provider's ref:
 * - `paid`: transfer succeeded (captures the hold);
 * - `unpaid`: transfer permanently failed (voids the hold; must never be inferred from a missing record);
 * - `pending`: transfer is still processing (never final);
 * - `not_received`: the provider has no record and vouches it never paid
 *   (safe to send again; a provider that can't vouch answers `unknown`, and
 *   the dispatcher reads it as `unknown` once the provider has given a ref);
 * - `unknown`: provider cannot determine the outcome (flags for attention).
 */
export type Standing =
  | { readonly status: "paid"; readonly providerRef: ProviderRef }
  | { readonly status: "unpaid"; readonly providerRef: ProviderRef }
  | { readonly status: "pending" }
  | { readonly status: "not_received" }
  | { readonly status: "unknown" }

/** Transport or protocol error from the provider; transfer outcome is indeterminate. */
export class ProviderError extends Schema.TaggedError<ProviderError>()("PayoutProvider.ProviderError", {
  message: Schema.String,
}) {}

/**
 * The provider refused the transfer, or would: a bug or a misconfiguration,
 * not an outage, so it's never retried.
 */
export class RefusedError extends Schema.TaggedError<RefusedError>()("PayoutProvider.RefusedError", {
  message: Schema.String,
}) {}

/** A callback as it arrived at plane's webhook. */
export interface CallbackRequest {
  readonly headers: { readonly [name: string]: string | undefined }
  readonly body: string
}

/** A payout's final outcome, as a verified callback reports it. */
export class Reported extends Schema.Class<Reported>("PayoutProvider.Reported")({
  payoutId: ID,
  outcome: Outcome,
  providerRef: ProviderRef,
}) {}

/** A callback the provider didn't sign (`unauthenticated`), or one it signed that plane can't read (`malformed`). */
export class InvalidCallback extends Schema.TaggedError<InvalidCallback>()("PayoutProvider.InvalidCallback", {
  reason: Schema.Literals(["unauthenticated", "malformed"]),
}) {}

/**
 * Bank payout provider interface. Final outcomes arrive via `Payouts.report`
 * or status polling; the ledger hold is captured or voided by the relay after
 * `report` updates the posting.
 */
export interface Interface {
  /**
   * Submits a transfer to the provider, idempotent by `payoutId`, and returns
   * the provider's reference.
   */
  readonly send: (transfer: Transfer) => Effect.Effect<ProviderRef, ProviderError | RefusedError>
  /** Queries the provider for the status of an unreported transfer. */
  readonly standing: (transfer: Transfer) => Effect.Effect<Standing, ProviderError>
  /** Verifies and reads a callback from the provider. */
  readonly callback: (request: CallbackRequest) => Effect.Effect<Reported, InvalidCallback>
}

export class Service extends Context.Service<Service, Interface>()("PayoutProvider") {}

export * as PayoutProvider from "./provider.ts"
