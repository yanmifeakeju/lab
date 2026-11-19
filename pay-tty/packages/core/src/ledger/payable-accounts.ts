import { Context, DateTime, Effect, Layer, Option, Result, Schema } from "effect"
import * as HttpClientError from "effect/unstable/http/HttpClientError"

import { LedgerClient } from "./client.ts"
import { Ledger } from "./slug.ts"

/** The ledger rejected the request or returned a closed account. */
export class RejectedError extends Schema.TaggedError<RejectedError>()(
  "PayableAccounts.RejectedError",
  { reason: Schema.String },
) {}

/** The ledger service was unreachable or returned a 5xx error. */
export class UnavailableError extends Schema.TaggedError<UnavailableError>()(
  "PayableAccounts.UnavailableError",
  {},
) {}

/** The ledger returned a malformed payload or a mismatched resource. */
export class BadResponseError extends Schema.TaggedError<BadResponseError>()(
  "PayableAccounts.BadResponseError",
  { reason: Schema.String },
) {}

/** The statement cursor was rejected by the ledger. */
export class CursorError extends Schema.TaggedError<CursorError>()("PayableAccounts.CursorError", {}) {}

export type Error = RejectedError | UnavailableError | BadResponseError

/** Holder identity for opening a payable account, keyed by `(ledger, externalId)`. */
export interface Holder {
  readonly ledger: Ledger.Slug
  readonly externalId: string
  readonly name: string
}

export class Account extends Schema.Class<Account>("PayableAccounts.Account")({
  holderRef: Schema.String,
  accountRef: Schema.String,
}) {}

/** In minor units, exact: the client refuses counters past 2^53−1. */
export class Balance extends Schema.Class<Balance>("PayableAccounts.Balance")({
  available: Schema.BigInt,
  // Pending credits (recorded but unsettled incoming funds).
  incoming: Schema.BigInt,
  // Pending debits (payout holds in flight, already deducted from `available`).
  held: Schema.BigInt,
}) {}

export class Movement extends Schema.Class<Movement>("PayableAccounts.Movement")({
  journalRef: Schema.String,
  // With `journalRef`, names the row: one entry can touch the account on two lines.
  lineNumber: Schema.Int,
  direction: Schema.Literals(["debit", "credit"]),
  amount: Schema.BigInt,
  balanceAfter: Schema.BigInt,
  description: Schema.String,
  purpose: Schema.String,
  recordedAt: Schema.Date,
}) {}

/** Keyset-paginated slice of an account's posted movements for a period. */
export class Statement extends Schema.Class<Statement>("PayableAccounts.Statement")({
  // Half-open period bounds `[from, to)`.
  period: Schema.Struct({ from: Schema.Date, to: Schema.Date }),
  // Period-wide opening and closing balances, independent of page position.
  opening: Schema.BigInt,
  closing: Schema.BigInt,
  movements: Schema.Array(Movement),
  // Cursors for newer and older pages, or null at either boundary.
  previous: Schema.NullOr(Schema.String),
  next: Schema.NullOr(Schema.String),
}) {}

/** Statement query window: initial period start date, or a continuation cursor. */
export type Window = { readonly from: Date } | { readonly cursor: string }

/** Account lookup target verified against the ledger's response. */
export interface Target {
  readonly accountRef: string
  readonly ledger: Ledger.Slug
}

export interface Interface {
  /**
   * Opens a payable account for `holder` in `holder.ledger`, or returns the
   * existing open account on retry.
   */
  readonly open: (holder: Holder) => Effect.Effect<Account, Error>

  readonly balance: (target: Target) => Effect.Effect<Balance, Error>

  /** Reads a page of posted movements for `target`, ordered newest first. */
  readonly statement: (target: Target, window: Window) => Effect.Effect<Statement, Error | CursorError>
}

export class Service extends Context.Service<Service, Interface>()("PayableAccounts") {}

// Maps a ledger client failure to a domain error; a 400 validation error is a defect.
const classify = (failure: LedgerClient.Failure): Effect.Effect<never, Error> =>
  Effect.flatMap(LedgerClient.classify(failure), (verdict) =>
    LedgerClient.Verdict.$match(verdict, {
      Unavailable: () => Effect.fail(new UnavailableError()),
      BadResponse: ({ reason }) => Effect.fail(new BadResponseError({ reason })),
      Rejected: ({ code }) => Effect.fail(new RejectedError({ reason: code })),
      Invalid: ({ response }) => Effect.die(response),
    }),
  )

// The caller chose the cursor, so the ledger refusing it is theirs to fix, unlike any other 400.
const refusesCursor = (failure: LedgerClient.Failure) =>
  !HttpClientError.isHttpClientError(failure) &&
  !Schema.isSchemaError(failure) &&
  failure.error.code === "validation_error" &&
  failure.error.details.some((detail) => detail.location === "query" && detail.field === "cursor")

const dateOf = (text: string) => Option.getOrUndefined(Option.map(DateTime.make(text), DateTime.toDateUtc))

const make = Effect.gen(function* () {
  const client = yield* LedgerClient.Service

  const open = Effect.fn("PayableAccounts.open")(function* (holder: Holder) {
    const { ledger, externalId, name } = holder

    const created = yield* Effect.result(
      client.createPayableAccount({ payload: { ledger, external_id: externalId, name } }),
    )

    if (Result.isFailure(created)) {
      yield* Effect.logWarning("ledger account creation failed", created.failure).pipe(
        Effect.annotateLogs({ externalId }),
      )

      return yield* classify(created.failure)
    }

    const account = created.success

    if (account.ledger_slug !== ledger || account.external_id !== externalId || account.name !== name) {
      return yield* new BadResponseError({
        reason: `ledger returned ${account.ledger_slug}/${account.external_id} for ${ledger}/${externalId}`,
      })
    }

    if (account.status !== "open" || account.closed_at !== null) {
      return yield* new RejectedError({ reason: "account_closed" })
    }

    return new Account({ holderRef: account.holder_reference, accountRef: account.reference })
  })

  const balance = Effect.fn("PayableAccounts.balance")(function* (target: Target) {
    const { accountRef, ledger } = target

    const read = yield* Effect.result(client.getAccount(accountRef, undefined))

    if (Result.isFailure(read)) {
      yield* Effect.logWarning("ledger account read failed", read.failure).pipe(Effect.annotateLogs({ accountRef }))

      return yield* classify(read.failure)
    }

    const account = read.success

    if (account.reference !== accountRef || account.ledger_slug !== ledger) {
      return yield* new BadResponseError({
        reason: `ledger returned ${account.ledger_slug}/${account.reference} for ${ledger}/${accountRef}`,
      })
    }

    return new Balance({
      available: BigInt(account.available),
      incoming: BigInt(account.balances.credits_pending),
      held: BigInt(account.balances.debits_pending),
    })
  })

  const statement = Effect.fn("PayableAccounts.statement")(function* (target: Target, window: Window) {
    const { accountRef } = target

    const params = "cursor" in window
      ? { order: "desc", cursor: window.cursor } as const
      : { order: "desc", from: window.from.toISOString() } as const

    const read = yield* Effect.result(client.getAccountStatement(accountRef, { params }))

    if (Result.isFailure(read)) {
      if (refusesCursor(read.failure)) {
        return yield* new CursorError()
      }

      yield* Effect.logWarning("ledger statement read failed", read.failure).pipe(Effect.annotateLogs({ accountRef }))

      return yield* classify(read.failure)
    }

    const answer = read.success

    if (answer.account.reference !== accountRef) {
      return yield* new BadResponseError({ reason: `ledger returned ${answer.account.reference} for ${accountRef}` })
    }

    const periodFrom = dateOf(answer.period.from)
    const periodTo = dateOf(answer.period.to)

    if (periodFrom === undefined || periodTo === undefined) {
      return yield* new BadResponseError({
        reason: `ledger returned period ${answer.period.from} to ${answer.period.to}`,
      })
    }

    const movements: Array<Movement> = []

    for (const entry of answer.entries) {
      const recordedAt = dateOf(entry.recorded_at)

      if (recordedAt === undefined) {
        return yield* new BadResponseError({ reason: `ledger returned recorded_at ${entry.recorded_at}` })
      }

      movements.push(
        new Movement({
          journalRef: entry.journal_reference,
          lineNumber: entry.line_number,
          direction: entry.direction,
          amount: BigInt(entry.amount),
          balanceAfter: BigInt(entry.balance_after),
          description: entry.description,
          purpose: entry.purpose,
          recordedAt,
        }),
      )
    }

    return new Statement({
      period: { from: periodFrom, to: periodTo },
      opening: BigInt(answer.opening_balance),
      closing: BigInt(answer.closing_balance),
      movements,
      previous: answer.page.previous_cursor,
      next: answer.page.next_cursor,
    })
  })

  return Service.of({ open, balance, statement })
})

export const layer = Layer.effect(Service)(make)

export * as PayableAccounts from "./payable-accounts.ts"
