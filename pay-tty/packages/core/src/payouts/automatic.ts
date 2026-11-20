import { and, asc, eq, isNotNull, isNull, lt, or, type SQL, sql } from "drizzle-orm"
import { Context, Effect, Layer, Result } from "effect"

import { Business } from "../business/business.ts"
import { businesses } from "../business/sql.ts"
import { Database } from "../database/client.ts"
import { PayableAccounts } from "../ledger/payable-accounts.ts"
import { Ledger } from "../ledger/slug.ts"
import { Service as Payouts } from "./payouts.ts"
import { payoutSettings } from "./sql.ts"

/** Businesses read per page of a run. */
export const pageSize = 100

export interface Interface {
  /**
   * The daily run for UTC `date`: every business due that day is paid out its
   * available balance, once. A business that fails (the ledger can't be read,
   * or its payouts are paused) is logged and stays due, so the next run
   * retries it. Returns how many payouts it created.
   */
  readonly run: (date: string) => Effect.Effect<number>
  /** Today's UTC date by the database's clock, which every run compares against. */
  readonly today: Effect.Effect<string>
}

export class Service extends Context.Service<Service, Interface>()("AutomaticPayouts") {}

interface Key {
  readonly businessId: string
  readonly ledger: string
}

interface Due extends Key {
  readonly accountRef: string | null
}

const make = Effect.gen(function* () {
  const database = yield* Database
  const payouts = yield* Payouts
  const accounts = yield* PayableAccounts.Service

  // A page of due businesses after `after`, in key order. Keyset paging, so a
  // business left due by a failure isn't read again in the same run.
  const due = (date: string, after: Key | null): Effect.Effect<ReadonlyArray<Due>> => {
    const dayStart = sql`(${date}::date)::timestamp at time zone 'UTC'`

    const conditions: Array<SQL | undefined> = [
      eq(payoutSettings.mode, "automatic"),
      lt(payoutSettings.automaticSince, dayStart),
      or(isNull(payoutSettings.lastRunOn), lt(payoutSettings.lastRunOn, date)),
      isNotNull(businesses.primaryPayableAccountRef),
    ]

    if (after !== null) {
      conditions.push(sql`(${payoutSettings.businessId}, ${payoutSettings.ledger}) > (${after.businessId}, ${after.ledger})`)
    }

    return database.use((db) =>
      db
        .select({
          businessId: payoutSettings.businessId,
          ledger: payoutSettings.ledger,
          accountRef: businesses.primaryPayableAccountRef,
        })
        .from(payoutSettings)
        .innerJoin(businesses, eq(businesses.id, payoutSettings.businessId))
        .where(and(...conditions))
        .orderBy(asc(payoutSettings.businessId), asc(payoutSettings.ledger))
        .limit(pageSize),
    )
  }

  const payOut = (date: string, row: Key & { readonly accountRef: string }) =>
    Effect.gen(function* () {
      const businessId = Business.ID.make(row.businessId)
      const ledger = Ledger.Slug.make(row.ledger)
      const balance = yield* Effect.result(accounts.balance({ accountRef: row.accountRef, ledger }))

      if (Result.isFailure(balance)) {
        yield* Effect.logWarning("automatic payout left for the next run: the balance couldn't be read", balance.failure)

        return false
      }

      const scheduled = yield* Effect.result(payouts.schedule(businessId, ledger, date, balance.success.available))

      if (Result.isFailure(scheduled)) {
        yield* Effect.logWarning("automatic payout left for the next run", scheduled.failure)

        return false
      }

      return scheduled.success !== null
    }).pipe(
      // A defect here, such as a database error, is this business's alone: the
      // rest of the run goes on, and the next run retries it.
      Effect.catchCause((cause) =>
        Effect.as(Effect.logError("automatic payout left for the next run: it died", cause), false)
      ),
      Effect.annotateLogs({ businessId: row.businessId, ledger: row.ledger, date }),
    )

  const run = Effect.fn("AutomaticPayouts.run")(function* (date: string) {
    let created = 0
    let after: Key | null = null

    for (;;) {
      const page: ReadonlyArray<Due> = yield* due(date, after)

      for (const row of page) {
        if (row.accountRef !== null && (yield* payOut(date, { ...row, accountRef: row.accountRef }))) {
          created += 1
        }
      }

      const last: Due | undefined = page.at(-1)

      if (last === undefined || page.length < pageSize) {
        return created
      }

      after = { businessId: last.businessId, ledger: last.ledger }
    }
  })

  const today = Effect.flatMap(
    database.use((db) =>
      db.execute<{ today: string }>(sql`select to_char(now() at time zone 'UTC', 'YYYY-MM-DD') as today`),
    ),
    (result) => {
      const date = result.rows[0]?.today

      return date === undefined ? Effect.die(new Error("the database gave no date")) : Effect.succeed(date)
    },
  )

  return Service.of({ run, today })
})

export const layer = Layer.effect(Service)(make)

export * as AutomaticPayouts from "./automatic.ts"
