import { Testing as Pool } from "@pay-tty/database/testing"
import { and, eq, sql } from "drizzle-orm"
import { Duration, Effect } from "effect"
import { ulid } from "ulid"

import { businesses } from "../business/sql.ts"
import { Database } from "../database/client.ts"
import { ledgerPostings, ledgers } from "../ledger/sql.ts"
import { paymentLinks, payments } from "../payments/sql.ts"
import { payouts } from "../payouts/sql.ts"

/**
 * Runs `effect` in a transaction on plane's database that always rolls back.
 * Nested transactions join it.
 */
export const rolledBack = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const database = yield* Database

    return yield* Pool.rolledBack(database, effect)
  })

/**
 * Runs `effect` inside a savepoint and rolls back to it, returning the Exit so
 * a test can inspect statement failures without aborting the outer transaction.
 */
export const attempt = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const database = yield* Database

    yield* database.use((db) => db.execute(sql`savepoint attempt`))

    const exit = yield* Effect.exit(effect)

    yield* database.use((db) => db.execute(sql`rollback to savepoint attempt`))
    yield* database.use((db) => db.execute(sql`release savepoint attempt`))

    return exit
  })

export const addLedger = (
  slug: string,
  currency: string,
  scale: number,
  countryCode: string | null = null,
) =>
  Effect.gen(function* () {
    const database = yield* Database

    yield* database.use((db) => db.insert(ledgers).values({ slug, currency, scale, countryCode }))
  })

/** Sets `slug` as its country's default ledger, replacing any existing default. */
export const makeCountryDefault = (slug: string) =>
  Effect.gen(function* () {
    const database = yield* Database

    yield* database.transaction(
      Effect.gen(function* () {
        const rows = yield* database.use((db) =>
          db.select({ countryCode: ledgers.countryCode }).from(ledgers).where(eq(ledgers.slug, slug)),
        )

        const countryCode = rows[0]?.countryCode

        if (countryCode === undefined || countryCode === null) {
          return yield* Effect.die(new Error(`ledger ${slug} has no country`))
        }

        yield* database.use((db) =>
          db
            .update(ledgers)
            .set({ isCountryDefault: false })
            .where(and(eq(ledgers.countryCode, countryCode), eq(ledgers.isCountryDefault, true))),
        )
        yield* database.use((db) => db.update(ledgers).set({ isCountryDefault: true }).where(eq(ledgers.slug, slug)))
      }),
    )
  })

export const clearCountryDefault = (countryCode: string) =>
  Effect.gen(function* () {
    const database = yield* Database

    yield* database.use((db) =>
      db
        .update(ledgers)
        .set({ isCountryDefault: false })
        .where(and(eq(ledgers.countryCode, countryCode), eq(ledgers.isCountryDefault, true))),
    )
  })

/**
 * Assigns a synthetic payable account reference to `businessId` and marks the
 * business `active` without calling the ledger service.
 */
export const openAccount = (businessId: string) =>
  Effect.gen(function* () {
    const database = yield* Database
    const accountRef = `acct_${ulid()}`

    yield* database.use((db) =>
      db
        .update(businesses)
        .set({ primaryPayableAccountRef: accountRef, ledgerHolderRef: `hld_${ulid()}`, status: "active" })
        .where(eq(businesses.id, businessId)),
    )

    return accountRef
  })

export const deactivateLink = (id: string) =>
  Effect.gen(function* () {
    const database = yield* Database

    yield* database.use((db) => db.update(paymentLinks).set({ deactivatedAt: sql`now()` }).where(eq(paymentLinks.id, id)))
  })

/** Backdates a pending payment's window so it is past `expires_at`. */
export const lapsePayment = (id: string) =>
  Effect.gen(function* () {
    const database = yield* Database

    yield* database.use((db) =>
      db
        .update(payments)
        .set({ createdAt: sql`now() - interval '31 minutes'`, expiresAt: sql`now() - interval '1 minute'` })
        .where(eq(payments.id, id)),
    )
  })

/** Backdates a payout's `created_at` and `expires_at` by `age`. */
export const createdAgo = (id: string, age: Duration.Duration) =>
  Effect.gen(function* () {
    const database = yield* Database

    yield* database.use((db) =>
      db
        .update(payouts)
        .set({
          createdAt: sql`${payouts.createdAt} - make_interval(secs => ${Duration.toSeconds(age)})`,
          expiresAt: sql`${payouts.expiresAt} - make_interval(secs => ${Duration.toSeconds(age)})`,
        })
        .where(eq(payouts.id, id)),
    )
  })

/**
 * Marks a confirmed payout's hold `pending` and transitions the payout to
 * `held` without calling the ledger service.
 */
export const holdRecorded = (id: string) =>
  Effect.gen(function* () {
    const database = yield* Database

    yield* database.use((db) =>
      db
        .update(ledgerPostings)
        .set({ state: "pending", journalRef: `jrn_${ulid()}`, recordedAt: sql`now()` })
        .where(and(eq(ledgerPostings.payoutId, id), eq(ledgerPostings.state, "created"))),
    )
    yield* database.use((db) =>
      db.update(payouts).set({ status: "held" }).where(and(eq(payouts.id, id), eq(payouts.status, "requested"))),
    )
  })

export * as Testing from "./testing.ts"
