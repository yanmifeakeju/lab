import { Business } from "@pay-tty/core/business"
import { Database } from "@pay-tty/core/database"
import { PayableAccounts } from "@pay-tty/core/ledger"
import { DateTime, Effect, Schema } from "effect"

/** The business's recorded state rules the request out. */
export class ConflictError extends Schema.TaggedError<ConflictError>()(
  "Account.ConflictError",
  { reason: Schema.String },
) {}

/** The business has no payable account yet, so no balance to read. */
export class NotOpenedError extends Schema.TaggedError<NotOpenedError>()(
  "Account.NotOpenedError",
  { id: Business.ID },
) {}

/**
 * Opens the business's payable account in the primary ledger saved when it
 * was created, records it, and activates the business. Repeating it returns
 * the business as it is; a failure leaves it created, with nothing recorded.
 */
export const open = Effect.fn("Account.open")(
  function* (business: Business.Info) {
    const businesses = yield* Business.Service

    if (business.status === "active") {
      return business
    }

    // Recorded before an interruption: finish without asking the ledger.
    if (business.primaryLedger.payableAccountRef !== null) {
      return yield* businesses.activate(business.id)
    }

    const accounts = yield* PayableAccounts.Service
    const database = yield* Database

    // Saved at creation, so a retry asks for the same account even if the
    // country's default has moved since.
    const ledger = business.primaryLedger.slug

    const account = yield* accounts.open({ ledger, externalId: business.id, name: business.name }).pipe(
      Effect.annotateLogs({ businessId: business.id }),
    )

    // Opened only once the ledger has answered, so no transaction waits on
    // it. The holder, account, and activation commit together.
    return yield* database
      .transaction(
        Effect.gen(function* () {
          yield* businesses.recordPayableAccount(
            business.id,
            ledger,
            new Business.PayableAccount({ holderRef: account.holderRef, accountRef: account.accountRef }),
          )

          return yield* businesses.activate(business.id)
        }),
      )
      .pipe(
        Effect.catchTag("Business.ConflictError", (conflict) => new ConflictError({ reason: conflict.message })),
      )
  },
  // A business is never deleted, so a missing one is a bug.
  Effect.catchTag("Business.NotFoundError", Effect.die),
)

/**
 * The balance of the business's payable account in its primary ledger, as
 * the ledger has it. The only ledger served is the primary one, so callers
 * name the business, not an account.
 */
export const balance = Effect.fn("Account.balance")(function* (business: Business.Info) {
  const { slug, payableAccountRef } = business.primaryLedger

  if (payableAccountRef === null) {
    return yield* new NotOpenedError({ id: business.id })
  }

  const accounts = yield* PayableAccounts.Service

  return yield* accounts.balance({ accountRef: payableAccountRef, ledger: slug }).pipe(
    Effect.annotateLogs({ businessId: business.id }),
  )
})

/** How far back a statement reaches: today since 00:00 UTC, or rolling days. */
export const Period = Schema.Literals(["today", "7d", "30d", "90d"])

export type Period = typeof Period.Type

export const defaultPeriod: Period = "30d"

const days: Readonly<Record<Exclude<Period, "today">, number>> = { "7d": 7, "30d": 30, "90d": 90 }

// The ledger checks `from` against its own clock, which can drift from ours,
// and a refused `from` is a defect. This keeps `from` clear of the end it sets
// a minute before its now, and the 90 days within its cap.
const drift = { minutes: 5 } as const

/** Where the period starts, at `now` by plane's clock. */
export const periodStart = (period: Period, now: DateTime.Utc) => {
  const latest = DateTime.subtract(now, drift)

  if (period === "today") {
    return DateTime.min(DateTime.startOf(now, "day"), latest)
  }

  const rolled = DateTime.subtract(now, { days: days[period] })

  return period === "90d" ? DateTime.add(rolled, drift) : rolled
}

/**
 * A page of the business's statement, newest first. A cursor carries its
 * own period, so `period` only places the first page.
 */
export const statement = Effect.fn("Account.statement")(function* (
  business: Business.Info,
  request: { readonly period?: Period; readonly cursor?: string },
) {
  const { slug, payableAccountRef } = business.primaryLedger

  if (payableAccountRef === null) {
    return yield* new NotOpenedError({ id: business.id })
  }

  const accounts = yield* PayableAccounts.Service
  const target = { accountRef: payableAccountRef, ledger: slug }

  // No `to`: the ledger ends the period a minute before its own now.
  const window = request.cursor === undefined
    ? { from: DateTime.toDateUtc(periodStart(request.period ?? defaultPeriod, yield* DateTime.now)) }
    : { cursor: request.cursor }

  return yield* accounts.statement(target, window).pipe(Effect.annotateLogs({ businessId: business.id }))
})

export * as Account from "./account.ts"
