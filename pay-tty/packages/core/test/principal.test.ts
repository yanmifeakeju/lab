import assert from "node:assert/strict"
import { test } from "node:test"

import { and, eq } from "drizzle-orm"
import { Effect } from "effect"
import { ulid } from "ulid"

import { Database } from "../src/database/client.ts"
import { Principal } from "../src/principal/principal.ts"
import { principals } from "../src/principal/sql.ts"
import { Testing } from "../src/testing/testing.ts"
import { runtime } from "./runtime.ts"

const identity = () => ({ issuer: "principal-test", subject: ulid() })

void test("finds nothing for an identity never seen", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const principals = yield* Principal.Service

        assert.equal(yield* principals.find(identity()), undefined)
      }),
    ),
  ))

void test("records an identity on first sight and returns it after", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const principals = yield* Principal.Service
        const who = identity()

        const first = yield* principals.ensure(who)
        const again = yield* principals.ensure(who)
        const found = yield* principals.find(who)

        assert.match(first.id, /^prn_/)
        assert.equal(first.issuer, who.issuer)
        assert.equal(first.subject, who.subject)
        assert.equal(again.id, first.id)
        assert.equal(found?.id, first.id)
      }),
    ),
  ))

void test("keeps identities apart by issuer", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const principals = yield* Principal.Service
        const subject = ulid()

        const ssh = yield* principals.ensure({ issuer: "ssh", subject })
        const web = yield* principals.ensure({ issuer: "web", subject })

        assert.notEqual(ssh.id, web.id)
      }),
    ),
  ))

// Committed: concurrent first sightings need separate connections.
void test("concurrent first sightings settle on one principal", () =>
  runtime.runPromise(
    Effect.gen(function* () {
      const service = yield* Principal.Service
      const database = yield* Database
      const who = identity()

      const seen = yield* Effect.all(
        Array.from({ length: 8 }, () => service.ensure(who)),
        { concurrency: "unbounded" },
      )

      const rows = yield* database.use((db) =>
        db
          .select()
          .from(principals)
          .where(and(eq(principals.issuer, who.issuer), eq(principals.subject, who.subject))),
      )

      assert.equal(new Set(seen.map((principal) => principal.id)).size, 1)
      assert.equal(rows.length, 1)
    }),
  ))

void test("gets a principal by its ID, and nothing for an unknown one", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const principals = yield* Principal.Service

        const recorded = yield* principals.ensure(identity())
        const found = yield* principals.get(recorded.id)

        assert.equal(found?.id, recorded.id)
        assert.equal(found?.issuer, recorded.issuer)
        assert.equal(found?.subject, recorded.subject)
        assert.equal(yield* principals.get(Principal.ID.make(`prn_${ulid()}`)), undefined)
      }),
    ),
  ))
