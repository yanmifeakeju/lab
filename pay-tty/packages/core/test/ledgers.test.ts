import assert from "node:assert/strict"
import { test } from "node:test"

import { and, eq } from "drizzle-orm"
import { Cause, Effect, Exit, Layer, Schema } from "effect"

import { Database } from "../src/database/client.ts"
import { Ledger } from "../src/ledger/ledger.ts"
import { Ledgers } from "../src/ledger/ledgers.ts"
import { ledgers, platformAccounts } from "../src/ledger/sql.ts"
import { Testing } from "../src/testing/testing.ts"
import { runtime } from "./runtime.ts"

// Loads the ledgers again, fresh rather than the runtime's memoised copy, inside
// the test's transaction so it sees the rows the test changed.
const load = Effect.scoped(Layer.build(Layer.fresh(Ledgers.layer)))

void test("loads each ledger with its currency, scale, and platform accounts", () =>
  runtime.runPromise(
    Effect.gen(function* () {
      const service = yield* Ledgers.Service
      const ngn = service.get(Ledger.ngn)

      assert.equal(ngn?.currency, "NGN")
      assert.equal(ngn?.scale, 2)
      assert.equal(ngn?.platformAccounts.cash, "acct_test_cash")
      assert.equal(ngn?.platformAccounts.fee, "acct_test_fee")
      assert.equal(service.get(Ledger.Slug.make("usd_us")), undefined)
    }),
  ))

void test("refuses to start when a platform account is missing", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const database = yield* Database

        yield* database.use((db) =>
          db
            .delete(platformAccounts)
            .where(and(eq(platformAccounts.ledger, Ledger.ngn), eq(platformAccounts.label, "fee"))),
        )
        yield* database.use((db) => db.insert(ledgers).values({ slug: "usd_us", currency: "USD", scale: 2 }))

        const error = yield* Effect.flip(load)

        assert.ok(Schema.is(Ledgers.MissingPlatformAccountsError)(error))
        assert.deepEqual(
          error.missing.map((missing) => `${missing.ledger}:${missing.label}`).sort(),
          ["ngn_ng:fee", "usd_us:cash", "usd_us:fee"],
        )
      }),
    ),
  ))

void test("refuses to start without the NGN ledger every business registers into", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const database = yield* Database

        yield* database.use((db) => db.delete(ledgers).where(eq(ledgers.slug, Ledger.ngn)))

        const error = yield* Effect.flip(load)

        assert.ok(Schema.is(Ledgers.MissingPlatformAccountsError)(error))
        assert.equal(error.missing.length, 2)
      }),
    ),
  ))

void test("refuses to start on a currency that isn't ISO 4217", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const database = yield* Database

        yield* database.use((db) => db.insert(ledgers).values({ slug: "xyz", currency: "XYZ", scale: 2 }))
        yield* database.use((db) =>
          db.insert(platformAccounts).values([
            { ledger: "xyz", label: "cash", ledgerAccountRef: "acct_xyz_cash" },
            { ledger: "xyz", label: "fee", ledgerAccountRef: "acct_xyz_fee" },
          ]),
        )

        const exit = yield* Effect.exit(load)

        assert.ok(Exit.isFailure(exit) && Cause.hasFails(exit.cause))
        assert.ok(Schema.isSchemaError(Cause.squash(exit.cause)))
      }),
    ),
  ))
