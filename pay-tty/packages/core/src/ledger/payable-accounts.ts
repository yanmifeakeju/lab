import { Context, DateTime, Effect, Layer, Option, Result, Schema } from "effect"
import * as HttpClientError from "effect/unstable/http/HttpClientError"

import { LedgerClient } from "./client.ts"
import { Ledger } from "./slug.ts"

/** The ledger refused the account, or returned one that is closed. */
export class RejectedError extends Schema.TaggedError<RejectedError>()(
  "PayableAccounts.RejectedError",
  { reason: Schema.String },
) {}

/** The ledger couldn't be reached or failed on its side. */
export class UnavailableError extends Schema.TaggedError<UnavailableError>()(
  "PayableAccounts.UnavailableError",
  {},
) {}

/** The ledger's answer is malformed or isn't the account asked for. */
export class BadResponseError extends Schema.TaggedError<BadResponseError>()(
  "PayableAccounts.BadResponseError",
  { reason: Schema.String },
) {}

/** The ledger refused the statement cursor the caller passed. */
export class CursorError extends Schema.TaggedError<CursorError>()("PayableAccounts.CursorError", {}) {}

export type Error = RejectedError | UnavailableError | BadResponseError

/** Who the account is for: the ledger keys it by ledger and external ID. */
export interface Holder {
  readonly ledger: Ledger.Slug
  readonly externalId: string
  readonly name: string
}

export class Account extends Schema.Class<Account>("PayableAccounts.Account")({
  holderRef: Schema.String,
  accountRef: Schema.String,
}) {}

/** In the ledger's minor units, exact: the client refuses counters past 2^53−1. */
export class Balance extends Schema.Class<Balance>("PayableAccounts.Balance")({
  available: Schema.BigInt,
  // Credits not yet posted.
  pending: Schema.BigInt,
}) {}

export class Movement extends Schema.Class<Movement>("PayableAccounts.Movement")({
  journalRef: Schema.String,
  // With journalRef, names the row: one entry can touch the account on two lines.
  lineNumber: Schema.Int,
  direction: Schema.Literals(["debit", "credit"]),
  amount: Schema.BigInt,
  balanceAfter: Schema.BigInt,
  description: Schema.String,
  purpose: Schema.String,
  recordedAt: Schema.Date,
}) {}

/** One page of the account's posted movements in a period, in minor units. */
export class Statement extends Schema.Class<Statement>("PayableAccounts.Statement")({
  // The ledger's own bounds; `to` is exclusive.
  period: Schema.Struct({ from: Schema.Date, to: Schema.Date }),
  // The balances either side of the whole period, whatever the page.
  opening: Schema.BigInt,
  closing: Schema.BigInt,
  // Newest first.
  movements: Schema.Array(Movement),
  // Opaque cursors to the newer and older pages; null at either end.
  previous: Schema.NullOr(Schema.String),
  next: Schema.NullOr(Schema.String),
}) {}

/** Where a page starts: a period's newest movements, or a cursor, which carries its own period. */
export type Window = { readonly from: Date } | { readonly cursor: string }

/** Which account to read: the ledger checks it answered for this one. */
export interface Target {
  readonly accountRef: string
  readonly ledger: Ledger.Slug
}

export interface Interface {
  /**
   * Opens the holder's payable account in the ledger, or returns the one it
   * already has: a repeat is safe. The account is open and is the one asked for.
   */
  readonly open: (holder: Holder) => Effect.Effect<Account, Error>

  /** The account's balance as the ledger has it, closed or not. */
  readonly balance: (target: Target) => Effect.Effect<Balance, Error>

  /** A page of the account's posted movements, newest first. */
  readonly statement: (target: Target, window: Window) => Effect.Effect<Statement, Error | CursorError>
}

export class Service extends Context.Service<Service, Interface>()("PayableAccounts") {}

// A 400 here is a catalog ledger the ledger service doesn't have.
const classify = (failure: LedgerClient.Failure): Effect.Effect<never, Error> =>
  Effect.flatMap(LedgerClient.classify(failure), (verdict) =>
    LedgerClient.Verdict.$match(verdict, {
      Unavailable: () => Effect.fail(new UnavailableError()),
      BadResponse: ({ reason }) => Effect.fail(new BadResponseError({ reason })),
      Rejected: ({ code }) => Effect.fail(new RejectedError({ reason: code })),
      Invalid: ({ response }) => Effect.die(response),
    }),
  )

// The caller chose the cursor, so the ledger refusing it is theirs to fix,
// unlike any other 400.
const refusesCursor = (failure: LedgerClient.Failure) =>
  !HttpClientError.isHttpClientError(failure) &&
  !Schema.isSchemaError(failure) &&
  failure.error.code === "validation_error" &&
  failure.error.details.some((detail) => detail.location === "query" && detail.field === "cursor")

// The ledger's timestamps, or undefined for one that isn't a time.
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

    return new Balance({ available: BigInt(account.available), pending: BigInt(account.balances.credits_pending) })
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
