import assert from "node:assert/strict"
import { test } from "node:test"

import { sql } from "drizzle-orm"
import { Effect, Exit } from "effect"
import { ulid } from "ulid"

import { Database } from "../src/database/client.ts"
import { create, drop, migrationsFolder, seed } from "../src/testing/setup.ts"
import { runtime } from "./runtime.ts"

const name = () => `pay_tty_setup_probe_${ulid().toLowerCase()}`

const exists = (database: string) =>
  Effect.gen(function* () {
    const db = yield* Database

    const result = yield* db.use((client) =>
      client.execute(sql`select 1 from pg_database where datname = ${database}`),
    )

    return result.rows.length === 1
  })

void test("creates, migrates, and seeds a database that drop removes", () =>
  runtime.runPromise(
    Effect.gen(function* () {
      const created = yield* create(name(), migrationsFolder, seed)

      assert.equal(yield* exists(created.name), true)

      yield* drop(created)

      assert.equal(yield* exists(created.name), false)
    }),
  ))

void test("a failed seed surfaces and leaves no database behind", () =>
  runtime.runPromise(
    Effect.gen(function* () {
      const database = name()

      const exit = yield* Effect.exit(create(database, migrationsFolder, "insert into nowhere values (1)"))

      assert.ok(Exit.isFailure(exit))
      assert.match(String(Exit.isFailure(exit) ? exit.cause : ""), /nowhere/)
      assert.equal(yield* exists(database), false)
    }),
  ))

void test("a failed migration surfaces and leaves no database behind", () =>
  runtime.runPromise(
    Effect.gen(function* () {
      const database = name()
      // No migration journal exists here.
      const missing = new URL("./no-migrations", import.meta.url).pathname

      const exit = yield* Effect.exit(create(database, missing, seed))

      assert.ok(Exit.isFailure(exit))
      assert.equal(yield* exists(database), false)
    }),
  ))

void test("failing to create never drops a database it didn't create", () =>
  runtime.runPromise(
    Effect.gen(function* () {
      const existing = yield* create(name(), migrationsFolder, seed)

      yield* Effect.gen(function* () {
        const exit = yield* Effect.exit(create(existing.name, migrationsFolder, seed))

        assert.ok(Exit.isFailure(exit))
        assert.equal(yield* exists(existing.name), true)
      }).pipe(Effect.ensuring(drop(existing)))
    }),
  ))
