import { and, eq, sql } from "drizzle-orm"
import { Data, Effect, Exit } from "effect"

import { Database } from "../database/client.ts"
import { ledgers } from "../ledger/sql.ts"

class Discarded<A, E> extends Data.TaggedError("Testing.Discarded")<{
  readonly exit: Exit.Exit<A, E>
}> {}

/**
 * Runs the effect in a transaction that is always rolled back, so a test
 * leaves nothing behind. Transactions opened inside it join it.
 */
export const rolledBack = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const database = yield* Database

    return yield* database
      .transaction(
        Effect.flatMap(Effect.exit(effect), (exit) => Effect.fail(new Discarded({ exit }))),
      )
      .pipe(Effect.catchTag("Testing.Discarded", (discarded) => discarded.exit))
  })

/**
 * Runs the effect behind a savepoint inside `rolledBack` and returns its exit.
 * A statement that fails aborts the whole transaction; rolling back to the
 * savepoint lets the test carry on.
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

/** Adds a catalog ledger, as the seed script does. */
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

/** Makes the ledger its country's default for new businesses, in place of any other. */
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

/** Leaves the country with no default ledger, so new businesses there fail. */
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

export * as Testing from "./testing.ts"
