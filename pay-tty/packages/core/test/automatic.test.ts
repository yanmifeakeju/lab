import assert from "node:assert/strict"
import { test } from "node:test"

import { and, eq, sql } from "drizzle-orm"
import { Effect, Layer, Logger, Predicate } from "effect"
import { ulid } from "ulid"

import { Business } from "../src/business/business.ts"
import { Database } from "../src/database/client.ts"
import { RelayNudge } from "../src/ledger/nudge.ts"
import { PayableAccounts } from "../src/ledger/payable-accounts.ts"
import { Ledger } from "../src/ledger/slug.ts"
import { ledgerPostings } from "../src/ledger/sql.ts"
import { AutomaticPayouts } from "../src/payouts/automatic.ts"
import { Payouts } from "../src/payouts/payouts.ts"
import { payouts as payoutRows, payoutSettings } from "../src/payouts/sql.ts"
import { Principal } from "../src/principal/principal.ts"
import { Testing } from "../src/testing/testing.ts"
import { runtime } from "./runtime.ts"

const ngn = Ledger.Slug.make("ngn_ng")

const gtbank = { bankCode: "058", accountNumber: "0123456789" } as const

// UTC dates by the database's clock, which `automatic_since` is set by, so a
// test run across midnight still agrees with it.
const days = Effect.gen(function* () {
  const database = yield* Database

  const result = yield* database.use((db) =>
    db.execute<{ yesterday: string; today: string; tomorrow: string; later: string }>(sql`
      select to_char(d - 1, 'YYYY-MM-DD') as yesterday, to_char(d, 'YYYY-MM-DD') as today,
        to_char(d + 1, 'YYYY-MM-DD') as tomorrow, to_char(d + 2, 'YYYY-MM-DD') as later
      from (select (now() at time zone 'UTC')::date as d) as now
    `),
  )

  return result.rows[0] ?? assert.fail("no dates")
})

// A business with an open account and payout settings in `mode`. Automatic
// ones switched two days ago, so they're due today.
const business = (mode: Payouts.Mode) =>
  Effect.gen(function* () {
    const principals = yield* Principal.Service
    const businesses = yield* Business.Service
    const payouts = yield* Payouts.Service
    const database = yield* Database

    const principal = yield* principals.ensure({ issuer: "automatic-test", subject: ulid() })
    const created = yield* businesses.create(principal.id, new Business.Details({ name: "Adaeze Studio", countryCode: "NG" }))
    const accountRef = yield* Testing.openAccount(created.id)

    yield* payouts.changeSettings(created.id, ngn, new Payouts.Change({ mode, destination: gtbank }))

    if (mode === "automatic") {
      yield* database.use((db) =>
        db
          .update(payoutSettings)
          .set({ automaticSince: sql`now() - interval '2 days'` })
          .where(eq(payoutSettings.businessId, created.id)),
      )
    }

    return { id: created.id, accountRef }
  })

const schedule = (businessId: Business.ID, date: string, available: bigint) =>
  Effect.flatMap(Payouts.Service, (payouts) => payouts.schedule(businessId, ngn, date, available))

const scheduledOf = (businessId: Business.ID) =>
  Effect.flatMap(Database, (database) =>
    database.use((db) =>
      db
        .select()
        .from(payoutRows)
        .where(and(eq(payoutRows.businessId, businessId), eq(payoutRows.trigger, "scheduled"))),
    ))

const nudgeless = Layer.succeed(RelayNudge.Service, RelayNudge.Service.of({ nudge: Effect.void, next: () => Effect.void }))

// Quiet: the run logs what it leaves for the next one.
const testing = Layer.mergeAll(Payouts.layer.pipe(Layer.provide(nudgeless)), Logger.layer([]))

const run = <A, E>(effect: Effect.Effect<A, E, Payouts.Service | Business.Service | Principal.Service | Database>) =>
  runtime.runPromise(Testing.rolledBack(effect.pipe(Effect.provide(testing))))

void test("the daily run pays out a due business once, confirmed and held like a manual payout", () =>
  run(
    Effect.gen(function* () {
      const { today, tomorrow } = yield* days
      const { id } = yield* business("automatic")

      const payout = yield* schedule(id, today, 4_200_000n)

      assert.ok(payout !== null)
      assert.deepEqual([payout.status, payout.amount], ["requested", 4_200_000n])

      const [row, ...rest] = yield* scheduledOf(id)

      assert.equal(rest.length, 0)
      assert.deepEqual([row?.scheduledFor, row?.idempotencyKey], [today, `auto:${id}:${ngn}:${today}`])

      const holds = yield* Effect.flatMap(Database, (database) =>
        database.use((db) => db.select().from(ledgerPostings).where(eq(ledgerPostings.payoutId, payout.id))))

      assert.deepEqual(holds.map((hold) => [hold.pending, hold.lines[0]?.amount]), [[true, "4200000"]])

      // The day is done: running it again, with more available, pays nothing more.
      assert.equal(yield* schedule(id, today, 9_000_000n), null)
      assert.equal((yield* scheduledOf(id)).length, 1)

      // The next day is a new run.
      assert.ok((yield* schedule(id, tomorrow, 1_000_000n)) !== null)
    }),
  ))

void test("a business that switched today, or is manual, isn't paid out until it is due", () =>
  run(
    Effect.gen(function* () {
      const payouts = yield* Payouts.Service
      const { today, tomorrow, later } = yield* days
      const { id: switched } = yield* business("manual")
      const { id: manual } = yield* business("manual")

      // Switched now: decision 11, from the next run.
      yield* payouts.changeSettings(switched, ngn, new Payouts.Change({ mode: "automatic", destination: gtbank }))

      assert.equal(yield* schedule(switched, today, 4_200_000n), null)
      assert.equal(yield* schedule(manual, today, 4_200_000n), null)
      assert.ok((yield* schedule(switched, tomorrow, 4_200_000n)) !== null)

      // Saving a new account while automatic keeps its place for the next run.
      yield* payouts.changeSettings(manual, ngn, new Payouts.Change({ mode: "automatic", destination: gtbank }))

      const since = (yield* Effect.flatMap(Database, (database) =>
        database.use((db) => db.select().from(payoutSettings).where(eq(payoutSettings.businessId, manual)))))[0]?.automaticSince

      yield* payouts.changeSettings(manual, ngn, new Payouts.Change({ mode: "automatic", destination: { bankCode: "058", accountNumber: "9876543210" } }))

      const after = (yield* Effect.flatMap(Database, (database) =>
        database.use((db) => db.select().from(payoutSettings).where(eq(payoutSettings.businessId, manual)))))[0]?.automaticSince

      assert.deepEqual(after, since)

      // Switching back to manual stops the run.
      yield* payouts.changeSettings(switched, ngn, new Payouts.Change({ mode: "manual", destination: gtbank }))

      assert.equal(yield* schedule(switched, later, 4_200_000n), null)
    }),
  ))

void test("below the minimum the day is done with nothing paid; while paused it is retried", () =>
  run(
    Effect.gen(function* () {
      const database = yield* Database
      const { yesterday, today } = yield* days
      const { id: small } = yield* business("automatic")
      const { id: paused } = yield* business("automatic")

      // ₦99.99 is under NGN's ₦100.00 minimum.
      assert.equal(yield* schedule(small, today, 9_999n), null)
      assert.equal(yield* schedule(small, today, 4_200_000n), null, "the day already ran")
      assert.equal((yield* scheduledOf(small)).length, 0)

      // A payout of the paused business whose capture the ledger refused.
      const blocker = yield* Effect.flatMap(Payouts.Service, (payouts) =>
        payouts.schedule(paused, ngn, yesterday, 1_000_000n))

      assert.ok(blocker !== null)
      yield* database.use((db) =>
        db
          .update(ledgerPostings)
          .set({ state: "refused", errorCode: "account_closed", journalRef: "jrn_hold", recordedAt: sql`now()`, resolution: "capture" })
          .where(eq(ledgerPostings.payoutId, blocker.id)),
      )

      const refused = yield* Effect.flip(schedule(paused, today, 4_200_000n))

      assert.ok(Predicate.isTagged(refused, "Payouts.LedgerMismatchError"))

      // Corrected, the same day goes out.
      yield* database.use((db) =>
        db
          .update(ledgerPostings)
          .set({ state: "voided", errorCode: null, resolution: "void", resolutionRef: "jrn_void", resolvedAt: sql`now()` })
          .where(eq(ledgerPostings.payoutId, blocker.id)),
      )

      assert.ok((yield* schedule(paused, today, 4_200_000n)) !== null)
    }),
  ))

void test("a run pays out every due business, and one whose balance can't be read is left for the next", () =>
  run(
    Effect.gen(function* () {
      const database = yield* Database
      const { today } = yield* days
      const paid = yield* business("automatic")
      const unread = yield* business("automatic")
      const broken = yield* business("automatic")
      let ledgerUp = false

      const savedAt = (businessId: Business.ID) =>
        Effect.map(
          database.use((db) => db.select().from(payoutSettings).where(eq(payoutSettings.businessId, businessId))),
          (rows) => rows[0]?.updatedAt,
        )

      const before = yield* savedAt(paid.id)

      const accounts = Layer.succeed(PayableAccounts.Service, PayableAccounts.Service.of({
        open: () => Effect.die("unused"),
        statement: () => Effect.die("unused"),
        balance: ({ accountRef }) =>
          accountRef === broken.accountRef
            ? Effect.die("a fault of this business's alone")
            : accountRef === unread.accountRef && !ledgerUp
            ? Effect.fail(new PayableAccounts.UnavailableError())
            : Effect.succeed(new PayableAccounts.Balance({ available: 4_200_000n, incoming: 0n, held: 0n })),
      }))

      const automatic = Effect.flatMap(AutomaticPayouts.Service, (service) => service.run(today)).pipe(
        Effect.provide(AutomaticPayouts.layer.pipe(Layer.provide(accounts))),
      )

      // One business dying doesn't stop the run for the others.
      yield* automatic
      assert.deepEqual([(yield* scheduledOf(paid.id)).length, (yield* scheduledOf(unread.id)).length], [1, 0])
      assert.deepEqual(yield* savedAt(paid.id), before, "a run isn't a settings change")

      ledgerUp = true
      yield* automatic
      assert.deepEqual([(yield* scheduledOf(paid.id)).length, (yield* scheduledOf(unread.id)).length], [1, 1])
    }),
  ))
