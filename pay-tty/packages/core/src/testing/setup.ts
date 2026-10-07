// A node:test global setup: each run gets a fresh database on the server in
// DATABASE_URL, migrated and seeded, and drops it afterwards. The database
// named in DATABASE_URL is never touched, only its server.

import { drizzle } from "drizzle-orm/node-postgres"
import { migrate } from "drizzle-orm/node-postgres/migrator"
import { Config, Effect, Redacted } from "effect"
import pg from "pg"
import { ulid } from "ulid"

export const migrationsFolder = new URL("../../migrations", import.meta.url).pathname

const localHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"])

// The platform accounts every session needs, so the Ledgers layer can load.
export const seed = `
  INSERT INTO ledgers (slug, currency, scale) VALUES ('ngn_ng', 'NGN', 2);
  INSERT INTO platform_accounts (ledger, label, ledger_account_ref) VALUES
    ('ngn_ng', 'cash', 'acct_test_cash'),
    ('ngn_ng', 'fee', 'acct_test_fee');
`

const withDatabase = (url: URL, database: string) => {
  const next = new URL(url)

  next.pathname = `/${database}`

  return next.href
}

const server = Effect.gen(function* () {
  const url = new URL(Redacted.value(yield* Config.Redacted("DATABASE_URL")))

  if (!localHosts.has(url.hostname)) {
    return yield* Effect.die(
      new Error(`refusing to create a test database on ${url.hostname}: not a local server`),
    )
  }

  return url
})

const exec = (connectionString: string, sql: string) =>
  Effect.acquireUseRelease(
    Effect.promise(() => {
      const client = new pg.Client({ connectionString })

      return client.connect().then(() => client)
    }),
    (client) => Effect.promise(() => client.query(sql)),
    (client) => Effect.promise(() => client.end()),
  )

// A database this setup created. Only these are ever dropped.
export interface Created {
  readonly admin: string
  readonly name: string
  readonly url: string
}

export const drop = (created: Created) =>
  exec(created.admin, `DROP DATABASE IF EXISTS "${created.name}" WITH (FORCE)`)

/**
 * Creates the database, migrates and seeds it. If migrating or seeding fails,
 * the database is dropped and the original failure surfaces; if creating it
 * fails, nothing is dropped, since the name may belong to someone else.
 */
export const create = (name: string, migrations: string, seedSql: string) =>
  Effect.gen(function* () {
    const url = yield* server

    const created: Created = {
      admin: withDatabase(url, "postgres"),
      name,
      url: withDatabase(url, name),
    }

    yield* exec(created.admin, `CREATE DATABASE "${name}"`)

    yield* Effect.acquireUseRelease(
      Effect.sync(() => new pg.Pool({ connectionString: created.url })),
      (pool) =>
        Effect.promise(() => migrate(drizzle(pool), { migrationsFolder: migrations })).pipe(
          Effect.andThen(Effect.promise(() => pool.query(seedSql))),
        ),
      (pool) => Effect.promise(() => pool.end()),
    ).pipe(
      Effect.onError(() =>
        drop(created).pipe(
          Effect.catchCause((cause) => Effect.logError("could not drop the test database", cause)),
        ),
      ),
    )

    return created
  })

// Node skips global teardown when global setup fails, so create cleans up
// after itself; this is set only once setup has fully succeeded.
let owned: Created | undefined

// Test processes start after this and inherit the environment, which is how
// they find the new database.
export const globalSetup = () =>
  Effect.runPromise(create(`pay_tty_test_${ulid().toLowerCase()}`, migrationsFolder, seed)).then(
    (created) => {
      owned = created
      // oxlint-disable-next-line effecttsgo/process-env
      process.env["DATABASE_URL"] = created.url
    },
  )

export const globalTeardown = () =>
  owned === undefined
    ? Promise.resolve()
    : Effect.runPromise(drop(owned)).then(() => {
        owned = undefined
      })
