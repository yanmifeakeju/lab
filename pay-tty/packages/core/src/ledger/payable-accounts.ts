import { Context, Effect, Layer, Result, Schema } from "effect"

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

  return Service.of({ open, balance })
})

export const layer = Layer.effect(Service)(make)

export * as PayableAccounts from "./payable-accounts.ts"
