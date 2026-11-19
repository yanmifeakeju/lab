import { drizzle, type NodePgQueryResultHKT } from "drizzle-orm/node-postgres"
import type { PgDatabase, PgTransactionConfig } from "drizzle-orm/pg-core"
import { Config, Context, Effect, Exit, Redacted, Semaphore } from "effect"
import pg from "pg"

// The connection pool, or the active transaction on it.
export type Executor = PgDatabase<NodePgQueryResultHKT>

export interface Interface {
  /** Runs `query` in the current transaction, or on the pool if none is open. */
  readonly use: <A>(query: (db: Executor) => PromiseLike<A>) => Effect.Effect<A>
  /**
   * Runs `effect` in a transaction. Nested calls join the outer transaction
   * under its config. Any failure, defect, or interruption rolls the
   * transaction back and surfaces unchanged.
   */
  readonly transaction: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    config?: PgTransactionConfig,
  ) => Effect.Effect<A, E, R>
}

// Carries an Exit out of Drizzle's transaction callback to force a rollback.
class Rollback<A, E> {
  readonly exit: Exit.Exit<A, E>

  constructor(exit: Exit.Exit<A, E>) {
    this.exit = exit
  }
}

/** Opens a pool for the database URL at `configKey`. */
export const make = (configKey: string) => Effect.flatMap(Config.Redacted(configKey), connect)

/**
 * Opens a pool on `url`. Each pool gets its own transaction reference, so
 * queries on one pool never join a transaction open on another.
 */
export const connect = (url: Redacted.Redacted) => Effect.gen(function* () {
  // A transaction runs on one connection, which takes one query at a time, so
  // queries from concurrent fibers inside it take turns.
  const CurrentTransaction = Context.Reference<{ readonly tx: Executor; readonly turn: Semaphore.Semaphore } | undefined>(
    // Not Effect's Crypto or Random: one needs a platform layer, the other is
    // seedable in tests, and the key must never repeat.
    // oxlint-disable-next-line effecttsgo/crypto-random-uuid-in-effect
    `Database.CurrentTransaction.${crypto.randomUUID()}`,
    { defaultValue: () => undefined },
  )

  const context = yield* Effect.context<never>()

  const pool = yield* Effect.acquireRelease(
    Effect.sync(() => new pg.Pool({ connectionString: Redacted.value(url) })),
    (pool) => Effect.promise(() => pool.end()),
  )

  // Handle errors on idle connections so a server-side disconnect does not
  // crash the process. The pool replaces the connection on the next checkout.
  pool.on("error", (error) => {
    Effect.runForkWith(context)(Effect.logWarning("idle database connection lost", error))
  })

  const db = drizzle(pool)

  const use = <A>(query: (db: Executor) => PromiseLike<A>) =>
    Effect.gen(function* () {
      const current = yield* CurrentTransaction

      if (current === undefined) {
        return yield* Effect.promise(() => query(db))
      }

      return yield* Semaphore.withPermit(current.turn, Effect.promise(() => query(current.tx)))
    })

  const transaction = <A, E, R>(effect: Effect.Effect<A, E, R>, config?: PgTransactionConfig) =>
    Effect.gen(function* () {
      if ((yield* CurrentTransaction) !== undefined) {
        return yield* effect
      }

      const caller = yield* Effect.context<R>()

      const exit = yield* Effect.callback<Exit.Exit<A, E>>((resume) => {
        const body = new AbortController()

        // Drizzle commits when the callback resolves and rolls back when it
        // rejects. A failed commit surfaces as a defect.
        const settled = db
          .transaction((tx) =>
            Effect.runPromiseExitWith(caller)(
              Effect.provideService(effect, CurrentTransaction, { tx, turn: Semaphore.makeUnsafe(1) }),
              { signal: body.signal },
            ).then((exit) => {
              if (Exit.isFailure(exit)) {
                throw new Rollback(exit)
              }

              return exit
            }),
            config,
          )
          .catch((cause: unknown) => {
            if (cause instanceof Rollback) {
              // SAFETY: Rollback is only thrown by the callback above and
              // carries this transaction's Exit<A, E>.
              return cause.exit as Exit.Exit<A, E>
            }

            throw cause
          })

        settled.then(
          (exit) => resume(Effect.succeed(exit)),
          (cause) => resume(Effect.die(cause)),
        )

        // On interruption, abort the body and wait for its finalizers to
        // complete so Drizzle rolls back and releases the connection cleanly.
        return Effect.promise(() => {
          body.abort()

          return settled.then(
            () => undefined,
            () => undefined,
          )
        })
      })

      return yield* exit
    })

  const service: Interface = { use, transaction }

  return service
})

export * as Database from "./client.ts"
