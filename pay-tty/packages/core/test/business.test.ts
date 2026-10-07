import assert from "node:assert/strict"
import { test } from "node:test"

import { eq, sql } from "drizzle-orm"
import { Cause, Effect, Exit, Predicate } from "effect"
import { ulid } from "ulid"

import { Business } from "../src/business/business.ts"
import { businesses, businessLedgers, businessPrincipals } from "../src/business/sql.ts"
import { Database } from "../src/database/client.ts"
import { Currency } from "../src/ledger/currency.ts"
import { Ledger } from "../src/ledger/ledger.ts"
import { ledgers } from "../src/ledger/sql.ts"
import { Principal } from "../src/principal/principal.ts"
import { Testing } from "../src/testing/testing.ts"
import { runtime } from "./runtime.ts"

const details = new Business.Details({ name: "Acme Ltd" })

const usd = Ledger.Slug.make("usd_us")

const asDefault = { isDefault: true }

const additional = { isDefault: false }

const account = (holderRef: string, accountRef = `acct_${ulid()}`) =>
  new Business.PayableAccount({ holderRef, accountRef })

const register = Effect.gen(function* () {
  const principals = yield* Principal.Service
  const service = yield* Business.Service

  const principal = yield* principals.ensure({ issuer: "business-test", subject: ulid() })
  const business = yield* service.create(principal.id, details)

  return { principal, business, service }
})

// Only inside a rolled-back test: committed tests share the database.
const addUsd = Effect.gen(function* () {
  const database = yield* Database

  yield* database.use((db) => db.insert(ledgers).values({ slug: usd, currency: "USD", scale: 2 }))
})

const accounts = (id: Business.ID) =>
  Effect.gen(function* () {
    const database = yield* Database

    return yield* database.use((db) =>
      db.select().from(businessLedgers).where(eq(businessLedgers.businessId, id)),
    )
  })

const holderRef = (id: Business.ID) =>
  Effect.gen(function* () {
    const database = yield* Database

    const rows = yield* database.use((db) =>
      db.select({ ref: businesses.ledgerHolderRef }).from(businesses).where(eq(businesses.id, id)),
    )

    return rows[0]?.ref
  })

const principalOf = (id: Business.ID) =>
  Effect.gen(function* () {
    const database = yield* Database

    const rows = yield* database.use((db) =>
      db.select().from(businessPrincipals).where(eq(businessPrincipals.businessId, id)),
    )

    return Principal.ID.make(rows[0]?.principalId ?? "")
  })

const reload = (id: Business.ID) =>
  Effect.gen(function* () {
    const service = yield* Business.Service

    return yield* service.findByPrincipal(yield* principalOf(id))
  })

const dies = <A, E>(exit: Exit.Exit<A, E>) => Exit.isFailure(exit) && Cause.hasDies(exit.cause)

const conflicts = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.flip(effect), Predicate.isTagged("Business.ConflictError"))

// The pg error a failed query raised, which Drizzle wraps.
const pgError = <A, E>(exit: Exit.Exit<A, E>) => {
  if (Exit.isSuccess(exit)) {
    return undefined
  }

  const defect = Cause.squash(exit.cause)

  return defect instanceof Error && defect.cause instanceof Error ? defect.cause : undefined
}

const violated = <A, E>(exit: Exit.Exit<A, E>) => {
  const error = pgError(exit)

  return error !== undefined && "constraint" in error ? error.constraint : undefined
}

const sqlState = <A, E>(exit: Exit.Exit<A, E>) => {
  const error = pgError(exit)

  return error !== undefined && "code" in error ? error.code : undefined
}

void test("create links an NGN business, created without a ledger or holder", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const { business } = yield* register

        assert.match(business.id, /^biz_/)
        assert.equal(business.name, "Acme Ltd")
        assert.equal(business.currencyCode, "NGN")
        assert.equal(business.status, "created")
        assert.equal(business.holderRef, null)
        assert.equal(business.ledger, null)
        assert.equal((yield* accounts(business.id)).length, 0)
      }),
    ),
  ))

void test("create is idempotent per principal and found by it", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const { principal, business, service } = yield* register

        const again = yield* service.create(principal.id, new Business.Details({ name: "Other" }))
        const found = yield* service.findByPrincipal(principal.id)

        assert.equal(again.id, business.id)
        assert.equal(again.name, "Acme Ltd")
        assert.equal(found?.id, business.id)
        assert.equal(found?.ledger, null)
      }),
    ),
  ))

void test("a principal without a business finds none", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const principals = yield* Principal.Service
        const service = yield* Business.Service

        const principal = yield* principals.ensure({ issuer: "business-test", subject: ulid() })

        assert.equal(yield* service.findByPrincipal(principal.id), undefined)
      }),
    ),
  ))

void test("create for an unknown principal is a defect", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const service = yield* Business.Service

        const exit = yield* Effect.exit(service.create(Principal.ID.make(`prn_${ulid()}`), details))

        assert.ok(dies(exit))
      }),
    ),
  ))

// Committed: the principal row lock only serialises separate connections.
void test("concurrent creates for one principal make one business", () =>
  runtime.runPromise(
    Effect.gen(function* () {
      const principals = yield* Principal.Service
      const service = yield* Business.Service

      const principal = yield* principals.ensure({ issuer: "business-test", subject: ulid() })

      const created = yield* Effect.all(
        Array.from({ length: 8 }, () => service.create(principal.id, details)),
        { concurrency: "unbounded" },
      )

      assert.equal(new Set(created.map((business) => business.id)).size, 1)
    }),
  ))

void test("records the default account with its holder; repeating it is a no-op", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const { business, service } = yield* register
        const payable = account("hld_1")

        yield* service.recordPayableAccount(business.id, Ledger.ngn, payable, asDefault)
        yield* service.recordPayableAccount(business.id, Ledger.ngn, payable, asDefault)

        const recorded = yield* reload(business.id)

        assert.equal(recorded?.holderRef, "hld_1")
        assert.deepEqual(
          recorded?.ledger,
          new Business.DefaultLedger({
            slug: Ledger.ngn,
            currency: Currency.Code.make("NGN"),
            scale: 2,
            payableAccountRef: payable.accountRef,
          }),
        )
        assert.equal((yield* accounts(business.id)).length, 1)
      }),
    ),
  ))

void test("a second account for the same ledger conflicts and keeps the first", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const { business, service } = yield* register
        const first = account("hld_1")

        yield* service.recordPayableAccount(business.id, Ledger.ngn, first, asDefault)

        assert.ok(yield* conflicts(service.recordPayableAccount(business.id, Ledger.ngn, account("hld_1"), asDefault)))
        assert.equal((yield* reload(business.id))?.ledger?.payableAccountRef, first.accountRef)
      }),
    ),
  ))

void test("a different holder conflicts", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const { business, service } = yield* register

        yield* service.recordPayableAccount(business.id, Ledger.ngn, account("hld_1"), asDefault)

        assert.ok(yield* conflicts(service.recordPayableAccount(business.id, Ledger.ngn, account("hld_2"), asDefault)))
        assert.equal(yield* holderRef(business.id), "hld_1")
      }),
    ),
  ))

void test("recording for an unknown business fails with NotFoundError", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const service = yield* Business.Service

        const error = yield* Effect.flip(
          service.recordPayableAccount(Business.ID.make(`biz_${ulid()}`), Ledger.ngn, account("hld_1"), asDefault),
        )

        assert.equal(error._tag, "Business.NotFoundError")
      }),
    ),
  ))

// Committed, so the record's own transaction is what rolls back.
void test("records the holder and the account together or not at all", () =>
  runtime.runPromise(
    Effect.gen(function* () {
      const { business: taken, service } = yield* register
      const { business } = yield* register
      const shared = account(`hld_${ulid()}`)

      yield* service.recordPayableAccount(taken.id, Ledger.ngn, shared, asDefault)

      // The account ref already belongs to another business, which is only
      // found after the holder has been set.
      assert.ok(
        yield* conflicts(
          service.recordPayableAccount(business.id, Ledger.ngn, account(`hld_${ulid()}`, shared.accountRef), asDefault),
        ),
      )
      assert.equal(yield* holderRef(business.id), null)
      assert.equal((yield* accounts(business.id)).length, 0)
    }),
  ))

// Committed: the business row lock only serialises separate connections.
void test("concurrent records of the same account make one default membership", () =>
  runtime.runPromise(
    Effect.gen(function* () {
      const { business, service } = yield* register
      const payable = account(`hld_${ulid()}`)

      yield* Effect.all(
        Array.from({ length: 8 }, () =>
          service.recordPayableAccount(business.id, Ledger.ngn, payable, asDefault),
        ),
        { concurrency: "unbounded" },
      )

      const rows = yield* accounts(business.id)

      assert.equal(rows.length, 1)
      assert.equal(rows[0]?.isDefault, true)
      assert.equal(rows[0]?.payableAccountRef, payable.accountRef)
    }),
  ))

void test("an additional ledger keeps the default, and is never shown as one", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const { business, service } = yield* register

        yield* addUsd

        // Recorded first, but not asked to be the default.
        yield* service.recordPayableAccount(business.id, usd, account("hld_1"), additional)

        assert.equal((yield* reload(business.id))?.ledger, null)

        const ngn = account("hld_1")

        yield* service.recordPayableAccount(business.id, Ledger.ngn, ngn, asDefault)
        yield* service.recordPayableAccount(business.id, Ledger.ngn, ngn, additional)

        assert.ok(yield* conflicts(service.recordPayableAccount(business.id, usd, account("hld_1"), asDefault)))

        const recorded = yield* reload(business.id)

        assert.equal(recorded?.ledger?.slug, Ledger.ngn)
        assert.equal(recorded?.ledger?.payableAccountRef, ngn.accountRef)
        assert.equal((yield* accounts(business.id)).filter((row) => row.isDefault).length, 1)
      }),
    ),
  ))

void test("a default must be in the business's currency", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const { business, service } = yield* register

        yield* addUsd

        // Behind a savepoint, so the refusal rolls back like it would on its own.
        assert.ok(
          yield* conflicts(
            Effect.flatMap(Testing.attempt(service.recordPayableAccount(business.id, usd, account("hld_1"), asDefault)), (exit) => exit),
          ),
        )
        assert.equal(yield* holderRef(business.id), null)
        assert.equal((yield* accounts(business.id)).length, 0)
      }),
    ),
  ))

void test("activation requires the holder and a default ledger", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const { business, service } = yield* register

        yield* addUsd

        assert.ok(dies(yield* Effect.exit(service.activate(business.id))))

        // A holder and an account, but not a default one.
        yield* service.recordPayableAccount(business.id, usd, account("hld_1"), additional)

        assert.ok(dies(yield* Effect.exit(service.activate(business.id))))
        assert.equal((yield* reload(business.id))?.status, "created")

        const payable = account("hld_1")

        yield* service.recordPayableAccount(business.id, Ledger.ngn, payable, asDefault)

        const active = yield* service.activate(business.id)

        assert.equal(active.status, "active")
        assert.equal(active.holderRef, "hld_1")
        assert.equal(active.currencyCode, "NGN")
        assert.equal(active.ledger?.slug, Ledger.ngn)
        assert.equal(active.ledger?.currency, "NGN")
        assert.equal(active.ledger?.scale, 2)
        assert.equal(active.ledger?.payableAccountRef, payable.accountRef)

        // Again: unchanged, not even its timestamp.
        assert.deepEqual(yield* service.activate(business.id), active)
      }),
    ),
  ))

void test("activation refuses a default ledger in another currency", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const database = yield* Database
        const { business, service } = yield* register

        yield* addUsd

        // Written directly: recording refuses this, so only a bypass of it
        // can leave such a default behind.
        yield* database.use((db) =>
          db.update(businesses).set({ ledgerHolderRef: "hld_1" }).where(eq(businesses.id, business.id)),
        )
        yield* database.use((db) =>
          db.insert(businessLedgers).values({ businessId: business.id, ledger: usd, isDefault: true, payableAccountRef: `acct_${ulid()}` }),
        )

        assert.ok(dies(yield* Effect.exit(service.activate(business.id))))
        assert.equal((yield* reload(business.id))?.status, "created")
      }),
    ),
  ))

void test("activate fails with NotFoundError for an unknown business", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const service = yield* Business.Service

        assert.equal((yield* Effect.flip(service.activate(Business.ID.make(`biz_${ulid()}`))))._tag, "Business.NotFoundError")
      }),
    ),
  ))

void test("the database rejects account rows that break the model", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const database = yield* Database
        const { business, service } = yield* register
        const { business: other } = yield* register
        const ref = `acct_${ulid()}`

        yield* addUsd
        yield* service.recordPayableAccount(business.id, Ledger.ngn, account("hld_1", ref), asDefault)

        const insert = (row: typeof businessLedgers.$inferInsert) =>
          Testing.attempt(database.use((db) => db.insert(businessLedgers).values(row)))

        assert.equal(
          violated(yield* insert({ businessId: business.id, ledger: Ledger.ngn, payableAccountRef: `acct_${ulid()}` })),
          "business_ledgers_business_id_ledger_pk",
        )
        assert.equal(
          violated(yield* insert({ businessId: other.id, ledger: usd, payableAccountRef: ref })),
          "business_ledgers_payable_account_ref_unique",
        )

        // Raw SQL, since the row type won't admit a missing ref. 23502 is
        // not_null_violation.
        for (const isDefault of [false, true]) {
          const exit = yield* Testing.attempt(
            database.use((db) =>
              db.execute(
                sql`insert into business_ledgers (business_id, ledger, is_default) values (${other.id}, ${usd}, ${isDefault})`,
              ),
            ),
          )

          assert.equal(sqlState(exit), "23502")
        }

        assert.equal(
          violated(yield* insert({ businessId: business.id, ledger: usd, isDefault: true, payableAccountRef: `acct_${ulid()}` })),
          "business_ledgers_default_unique",
        )
        assert.equal(
          violated(yield* insert({ businessId: business.id, ledger: "missing", payableAccountRef: `acct_${ulid()}` })),
          "business_ledgers_ledger_ledgers_slug_fk",
        )

        // A further ledger with its own account is fine.
        assert.ok(
          Exit.isSuccess(yield* insert({ businessId: business.id, ledger: usd, payableAccountRef: `acct_${ulid()}` })),
        )
      }),
    ),
  ))
