import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres"
import { Config, Context, Effect, Layer, Redacted } from "effect"
import pg from "pg"

export type Drizzle = NodePgDatabase

export class Database extends Context.Service<Database, Drizzle>()(
  "Database",
) {}

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

  return drizzle(pool)
})

export const layer = Layer.effect(Database)(make)
