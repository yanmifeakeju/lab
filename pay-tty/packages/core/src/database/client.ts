import { drizzle, type NodePgQueryResultHKT } from "drizzle-orm/node-postgres"
import type { PgDatabase } from "drizzle-orm/pg-core"
import { Config, Context, Effect, Exit, Layer, Redacted } from "effect"
import pg from "pg"

// The pool, or the transaction a caller opened.
export type Executor = PgDatabase<NodePgQueryResultHKT>

export interface Interface {
  /** Runs a query in the current transaction, or on the pool outside one. */
  readonly use: <A>(query: (db: Executor) => PromiseLike<A>) => Effect.Effect<A>
  /**
   * Runs the effect in a transaction that a nested call joins. Failure, a
   * defect, or interruption rolls it back and surfaces unchanged.
   */
  readonly transaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

export class Database extends Context.Service<Database, Interface>()(
  "Database",
) {}

// Set while a transaction is open, so every query inside it joins.
const CurrentTransaction = Context.Reference<Executor | undefined>(
  "Database.CurrentTransaction",
  { defaultValue: () => undefined },
)

// Thrown out of Drizzle's callback to roll back, carrying the exit through.
class Rollback<A, E> {
  readonly exit: Exit.Exit<A, E>

  constructor(exit: Exit.Exit<A, E>) {
    this.exit = exit
  }
}

const make = Effect.gen(function* () {
  const url = yield* Config.Redacted("DATABASE_URL")

  const context = yield* Effect.context<never>()

  const pool = yield* Effect.acquireRelease(
    Effect.sync(() => new pg.Pool({ connectionString: Redacted.value(url) })),
    (pool) => Effect.promise(() => pool.end()),
  )

  // An idle connection dropped by the server is emitted here; unhandled, it
  // would crash the process. The pool replaces it on the next checkout, and
  // queries that were running fail on their own.
  pool.on("error", (error) => {
    Effect.runForkWith(context)(Effect.logWarning("idle database connection lost", error))
  })

  const db = drizzle(pool)

  const use = <A>(query: (db: Executor) => PromiseLike<A>) =>
    Effect.gen(function* () {
      const tx = yield* CurrentTransaction

      return yield* Effect.promise(() => query(tx ?? db))
    })

  const transaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      if ((yield* CurrentTransaction) !== undefined) {
        return yield* effect
      }

      const caller = yield* Effect.context<R>()

      const exit = yield* Effect.callback<Exit.Exit<A, E>>((resume) => {
        const body = new AbortController()

        // Drizzle commits when the callback resolves and rolls back when it
        // throws; a commit that fails is a defect like any failed query.
        const settled = db
          .transaction((tx) =>
            Effect.runPromiseExitWith(caller)(
              Effect.provideService(effect, CurrentTransaction, tx),
              { signal: body.signal },
            ).then((exit) => {
              if (Exit.isFailure(exit)) {
                throw new Rollback(exit)
              }

              return exit
            }),
          )
          .catch((cause: unknown) => {
            if (cause instanceof Rollback) {
              // SAFETY: only this call's callback throws a Rollback, and it
              // carries this call's exit.
              return cause.exit as Exit.Exit<A, E>
            }

            throw cause
          })

        settled.then(
          (exit) => resume(Effect.succeed(exit)),
          (cause) => resume(Effect.die(cause)),
        )

        // Interrupting the caller interrupts the body and waits for it: its
        // finalizers run, then Drizzle rolls back and releases the connection.
        // A query already sent finishes first, since the connection runs one
        // statement at a time.
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

  return Database.of({ use, transaction })
})

export const layer = Layer.effect(Database)(make)
