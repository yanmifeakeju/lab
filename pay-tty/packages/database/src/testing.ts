// Ephemeral databases for test runs, on local Postgres unless a test names
// another server, never the app's configured databases.
//
// Each test file that needs a database calls `withDatabase`, which creates,
// migrates and seeds a fresh one, and drops it in its own `after` once its
// pools are closed. A killed run leaves its databases.

import { Data, Effect, Exit, type Layer, Redacted } from "effect"
import { drizzle } from "drizzle-orm/node-postgres"
import { migrate } from "drizzle-orm/node-postgres/migrator"
import type { MigrationConfig } from "drizzle-orm/migrator"
import pg from "pg"

import type { Interface } from "./client.ts"

/** The server test databases are made on, unless a test names another. */
export const defaultServer = "postgres://postgres:postgres@localhost:5432"

/** Where config-based database layers point during tests: nowhere. */
export const unassigned = "postgres://unassigned.invalid/unassigned"

const withPath = (url: URL, database: string) => {
  const next = new URL(url)

  next.pathname = `/${database}`

  return next.href
}

const exec = (server: string, sql: string) =>
  Effect.acquireUseRelease(
    Effect.sync(() => new pg.Client({ connectionString: server })).pipe(
      Effect.tap((client) =>
        Effect.promise(() => client.connect()).pipe(
          // A client whose connect fails is still ended.
          Effect.onError(() => Effect.promise(() => client.end().catch(() => undefined))),
        )),
    ),
    (client) => Effect.promise(() => client.query(sql)),
    (client) => Effect.promise(() => client.end()),
  )

/** A schema to create test databases with, and the layer a database's URL gives. */
export interface Schema<A, E = never, R = never> {
  /** Lowercase letters, digits and `_`; names are this plus 12 hex digits. */
  readonly prefix: string
  readonly migrations: MigrationConfig
  readonly seed: string
  readonly layer: (url: Redacted.Redacted) => Layer.Layer<A, E, R>
}

/** A test file's own database. */
export interface FileDatabase<A, E, R> {
  readonly name: string
  readonly url: string
  /** Each build opens its own pool. */
  readonly layer: Layer.Layer<A, E, R>
  /** Drops this database; close every pool on it first. */
  readonly drop: () => Promise<void>
}

const random = () => Buffer.from(crypto.getRandomValues(new Uint8Array(6))).toString("hex")

/**
 * Creates, migrates and seeds a fresh database of `schema` for the calling
 * test file, on `server`. If migration or seeding fails, the database is
 * dropped before the error surfaces.
 */
export const withDatabase = <A, E, R>(schema: Schema<A, E, R>, server: string = defaultServer): Promise<FileDatabase<A, E, R>> =>
  Effect.runPromise(
    Effect.gen(function* () {
      if (!/^[a-z0-9_]+$/.test(schema.prefix)) {
        return yield* Effect.die(new Error(`test database prefix "${schema.prefix}" must be lowercase letters, digits and _`))
      }

      const maintenance = withPath(new URL(server), "postgres")
      const name = `${schema.prefix}${random()}`
      const url = withPath(new URL(server), name)
      // The name is generated, so it needs no escaping.
      const drop = Effect.asVoid(exec(maintenance, `DROP DATABASE IF EXISTS "${name}"`))

      yield* exec(maintenance, `CREATE DATABASE "${name}"`)

      yield* Effect.acquireUseRelease(
        Effect.sync(() => new pg.Pool({ connectionString: url })),
        (pool) =>
          Effect.promise(() => migrate(drizzle(pool), schema.migrations)).pipe(
            Effect.andThen(Effect.promise(() => pool.query(schema.seed))),
          ),
        (pool) => Effect.promise(() => pool.end()),
      ).pipe(
        Effect.onError(() => drop.pipe(Effect.catchCause((cause) => Effect.logError("could not drop the test database", cause)))),
      )

      const run = Effect.runPromiseWith(yield* Effect.context<never>())

      const database: FileDatabase<A, E, R> = {
        name,
        url,
        layer: schema.layer(Redacted.make(url)),
        drop: () => run(drop),
      }

      return database
    }),
  )

/**
 * A package's node:test global setup. It touches no database: it points
 * DATABASE_URL and SIM_DATABASE_URL at nothing, so no config-based layer
 * reaches dev data.
 */
export const globalSetup = () => {
  for (const key of ["DATABASE_URL", "SIM_DATABASE_URL"]) {
    // oxlint-disable-next-line effecttsgo/process-env
    process.env[key] = unassigned
  }
}

class Discarded<A, E> extends Data.TaggedError("Testing.Discarded")<{
  readonly exit: Exit.Exit<A, E>
}> {}

/**
 * Runs `effect` inside a transaction on `database` that always rolls back.
 * Nested transactions join it.
 */
export const rolledBack = <A, E, R>(database: Interface, effect: Effect.Effect<A, E, R>) =>
  database
    .transaction(Effect.flatMap(Effect.exit(effect), (exit) => Effect.fail(new Discarded({ exit }))))
    .pipe(Effect.catchTag("Testing.Discarded", (discarded) => discarded.exit))

export * as Testing from "./testing.ts"
