import assert from "node:assert/strict"
import { test } from "node:test"

import { eq } from "drizzle-orm"
import { Cause, Effect, Exit, Predicate, Schema } from "effect"
import { ulid } from "ulid"

import { Business } from "../src/business/business.ts"
import { businesses } from "../src/business/sql.ts"
import { Database } from "../src/database/client.ts"
import { Catalog } from "../src/ledger/catalog.ts"
import { Currency } from "../src/ledger/currency.ts"
import { Ledger } from "../src/ledger/ledger.ts"
import { ledgers } from "../src/ledger/sql.ts"
import { Principal } from "../src/principal/principal.ts"
import { Testing } from "../src/testing/testing.ts"
import { runtime } from "./runtime.ts"

const nigeria = new Business.Details({ name: "Acme Ltd", countryCode: "NG" })

const account = (holderRef: string, accountRef = `acct_${ulid()}`) =>
  new Business.PayableAccount({ holderRef, accountRef })

// A principal and its new business, with no ledger account yet.
const createBusiness = (details = nigeria) =>
  Effect.gen(function* () {
    const principals = yield* Principal.Service
    const service = yield* Business.Service

    const principal = yield* principals.ensure({ issuer: "business-test", subject: ulid() })
    const business = yield* service.create(principal.id, details)

    return { principal, business, service, ledger: business.primaryLedger.slug }
  })

// A catalog ledger only this test sees, so only inside a rolled-back test.
const addLedger = (currency: string, countryCode: string | null = null) =>
  Effect.gen(function* () {
    const slug = Ledger.Slug.make(`${currency.toLowerCase()}_test_${ulid().toLowerCase()}`)

    yield* Testing.addLedger(slug, currency, 2, countryCode)

    return slug
  })

// The seed configures no US ledger; these tests stand one in.
const addUsDefault = Effect.gen(function* () {
  const slug = yield* addLedger("USD", "US")

  yield* Testing.makeCountryDefault(slug)

  return slug
})

const countryDefault = (countryCode: string) =>
  Effect.gen(function* () {
    const catalog = yield* Catalog.Service

    const entry = yield* catalog.findCountryDefault(countryCode)

    assert.ok(entry !== undefined, countryCode)

    return entry
  })

// The business as stored, read without going through the service.
const stored = (id: Business.ID) =>
  Effect.gen(function* () {
    const database = yield* Database

    const rows = yield* database.use((db) => db.select().from(businesses).where(eq(businesses.id, id)))

    return rows[0]
  })

const dies = <A, E>(exit: Exit.Exit<A, E>) => Exit.isFailure(exit) && Cause.hasDies(exit.cause)

const conflicts = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.flip(effect), Predicate.isTagged("Business.ConflictError"))

// The constraint a failed query violated; pg's error is the cause Drizzle wraps.
const violated = <A, E>(exit: Exit.Exit<A, E>) => {
  if (Exit.isSuccess(exit)) {
    return undefined
  }

  const defect = Cause.squash(exit.cause)
  const error = defect instanceof Error && defect.cause instanceof Error ? defect.cause : undefined

  return error !== undefined && "constraint" in error ? error.constraint : undefined
}

void test("create saves an NG business in NGN, with its country's default ledger and no account", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const { business } = yield* createBusiness()
        const primary = yield* countryDefault("NG")

        assert.match(business.id, /^biz_/)
        assert.equal(business.name, "Acme Ltd")
        assert.equal(business.countryCode, "NG")
        assert.equal(business.currencyCode, "NGN")
        assert.equal(business.status, "created")
        assert.equal(business.holderRef, null)
        assert.deepEqual(
          business.primaryLedger,
          new Business.PrimaryLedger({
            slug: primary.slug,
            currency: primary.currency,
            scale: primary.scale,
            payableAccountRef: null,
          }),
        )
      }),
    ),
  ))

void test("create saves a US business in USD, with the US default ledger", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const usd = yield* addUsDefault
        const { business } = yield* createBusiness(new Business.Details({ name: "Acme Inc", countryCode: "US" }))

        assert.equal(business.countryCode, "US")
        assert.equal(business.currencyCode, "USD")
        assert.equal(business.primaryLedger.slug, usd)
        assert.equal(business.primaryLedger.currency, "USD")
        assert.equal(business.primaryLedger.payableAccountRef, null)
      }),
    ),
  ))

void test("maps each country to its currency", () => {
  assert.equal(Business.currencyOf("NG"), "NGN")
  assert.equal(Business.currencyOf("US"), "USD")
})

void test("an identical create is idempotent per principal and found by it", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const { principal, business, service } = yield* createBusiness()

        const again = yield* service.create(principal.id, nigeria)
        const found = yield* service.findByPrincipal(principal.id)

        assert.deepEqual(again, business)
        assert.deepEqual(found, business)
      }),
    ),
  ))

void test("a repeat create with another name or country conflicts and changes nothing", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const { principal, business, service } = yield* createBusiness()

        // US has no default ledger here; the conflict is found first.
        for (const details of [
          new Business.Details({ name: "Other Ltd", countryCode: "NG" }),
          new Business.Details({ name: "Acme Ltd", countryCode: "US" }),
          new Business.Details({ name: "acme ltd", countryCode: "NG" }),
        ]) {
          assert.ok(yield* conflicts(service.create(principal.id, details)), `${details.name}/${details.countryCode}`)
        }

        assert.deepEqual(yield* service.findByPrincipal(principal.id), business)
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

        const exit = yield* Effect.exit(service.create(Principal.ID.make(`prn_${ulid()}`), nigeria))

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
        Array.from({ length: 8 }, () => service.create(principal.id, nigeria)),
        { concurrency: "unbounded" },
      )

      assert.equal(new Set(created.map((business) => business.id)).size, 1)
    }),
  ))

void test("moving a country's default retargets new businesses, not existing ones", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const before = yield* createBusiness()
        const moved = Ledger.Slug.make(`ngn_alt_${ulid().toLowerCase()}`)

        yield* Testing.addLedger(moved, "NGN", 2, "NG")
        yield* Testing.makeCountryDefault(moved)

        const after = yield* createBusiness()

        assert.equal(after.ledger, moved)
        assert.notEqual(before.ledger, moved)
        assert.equal((yield* before.service.findByPrincipal(before.principal.id))?.primaryLedger.slug, before.ledger)

        // The existing business still records into its saved ledger.
        yield* before.service.recordPayableAccount(before.business.id, before.ledger, account("hld_1"))

        assert.equal((yield* before.service.activate(before.business.id)).primaryLedger.slug, before.ledger)
      }),
    ),
  ))

void test("a country without a default ledger is unavailable and creates nothing, with no fallback", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const principals = yield* Principal.Service
        const service = yield* Business.Service

        const principal = yield* principals.ensure({ issuer: "business-test", subject: ulid() })

        const error = yield* Effect.flip(service.create(principal.id, new Business.Details({ name: "Acme Inc", countryCode: "US" })))

        assert.deepEqual(error, new Business.CountryUnavailableError({ countryCode: "US" }))
        assert.equal(yield* service.findByPrincipal(principal.id), undefined)
      }),
    ),
  ))

void test("a default ledger in another currency than its country's is a defect and creates nothing", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const principals = yield* Principal.Service
        const service = yield* Business.Service

        yield* Testing.makeCountryDefault(yield* addLedger("EUR", "US"))

        const principal = yield* principals.ensure({ issuer: "business-test", subject: ulid() })

        assert.ok(dies(yield* Testing.attempt(service.create(principal.id, new Business.Details({ name: "Acme Inc", countryCode: "US" })))))
        assert.equal(yield* service.findByPrincipal(principal.id), undefined)
      }),
    ),
  ))

void test("records the primary account with its holder; repeating it is a no-op", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const { principal, business, service, ledger } = yield* createBusiness()
        const payable = account("hld_1")

        yield* service.recordPayableAccount(business.id, ledger, payable)
        yield* service.recordPayableAccount(business.id, ledger, payable)

        const recorded = yield* service.findByPrincipal(principal.id)

        assert.equal(recorded?.holderRef, "hld_1")
        assert.equal(recorded.status, "created")
        assert.deepEqual(
          recorded.primaryLedger,
          new Business.PrimaryLedger({
            slug: ledger,
            currency: Currency.Code.make("NGN"),
            scale: 2,
            payableAccountRef: payable.accountRef,
          }),
        )
      }),
    ),
  ))

void test("a different account, holder, or ledger conflicts and keeps what was recorded", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const { business, service, ledger } = yield* createBusiness()
        const first = account("hld_1")

        yield* service.recordPayableAccount(business.id, ledger, first)

        assert.ok(yield* conflicts(service.recordPayableAccount(business.id, ledger, account("hld_1"))))
        assert.ok(yield* conflicts(service.recordPayableAccount(business.id, ledger, account("hld_2", first.accountRef))))
        assert.ok(
          yield* conflicts(service.recordPayableAccount(business.id, yield* addLedger("NGN"), first)),
        )

        const row = yield* stored(business.id)

        assert.equal(row?.ledgerHolderRef, "hld_1")
        assert.equal(row.primaryPayableAccountRef, first.accountRef)
        assert.equal(row.primaryLedger, ledger)
      }),
    ),
  ))

void test("a ledger other than the saved primary conflicts before anything is recorded", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const { business, service } = yield* createBusiness()

        assert.ok(
          yield* conflicts(service.recordPayableAccount(business.id, yield* addLedger("NGN"), account("hld_1"))),
        )

        const row = yield* stored(business.id)

        assert.equal(row?.ledgerHolderRef, null)
        assert.equal(row.primaryPayableAccountRef, null)
      }),
    ),
  ))

void test("recording for an unknown business fails with NotFoundError", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const service = yield* Business.Service

        const error = yield* Effect.flip(
          service.recordPayableAccount(Business.ID.make(`biz_${ulid()}`), Ledger.Slug.make("ngn_ng"), account("hld_1")),
        )

        assert.equal(error._tag, "Business.NotFoundError")
      }),
    ),
  ))

// Committed, so another business's account is visible as it would be.
void test("another business's account conflicts and records nothing", () =>
  runtime.runPromise(
    Effect.gen(function* () {
      const taken = yield* createBusiness()
      const { business, service, ledger } = yield* createBusiness()
      const shared = account(`hld_${ulid()}`)

      yield* service.recordPayableAccount(taken.business.id, taken.ledger, shared)

      assert.ok(
        yield* conflicts(service.recordPayableAccount(business.id, ledger, account(`hld_${ulid()}`, shared.accountRef))),
      )

      const row = yield* stored(business.id)

      assert.equal(row?.ledgerHolderRef, null)
      assert.equal(row.primaryPayableAccountRef, null)
    }),
  ))

// Committed: the business row lock only serialises separate connections.
void test("concurrent records of the same account record it once", () =>
  runtime.runPromise(
    Effect.gen(function* () {
      const { business, service, ledger } = yield* createBusiness()
      const payable = account(`hld_${ulid()}`)

      yield* Effect.all(
        Array.from({ length: 8 }, () => service.recordPayableAccount(business.id, ledger, payable)),
        { concurrency: "unbounded" },
      )

      const row = yield* stored(business.id)

      assert.equal(row?.ledgerHolderRef, payable.holderRef)
      assert.equal(row.primaryPayableAccountRef, payable.accountRef)
    }),
  ))

void test("activation requires the primary account, and repeating it changes nothing", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const { business, service, ledger } = yield* createBusiness()

        assert.ok(dies(yield* Effect.exit(service.activate(business.id))))
        assert.equal((yield* stored(business.id))?.status, "created")

        const payable = account("hld_1")

        yield* service.recordPayableAccount(business.id, ledger, payable)

        const active = yield* service.activate(business.id)

        assert.equal(active.status, "active")
        assert.equal(active.holderRef, "hld_1")
        assert.equal(active.currencyCode, "NGN")
        assert.equal(active.primaryLedger.slug, ledger)
        assert.equal(active.primaryLedger.currency, "NGN")
        assert.equal(active.primaryLedger.scale, 2)
        assert.equal(active.primaryLedger.payableAccountRef, payable.accountRef)

        // Again: unchanged, not even its timestamp.
        assert.deepEqual(yield* service.activate(business.id), active)
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

void test("the database rejects business rows that break the model", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const database = yield* Database
        const { business, service, ledger } = yield* createBusiness()
        const usd = yield* addLedger("USD")
        const ref = `acct_${ulid()}`

        yield* service.recordPayableAccount(business.id, ledger, account("hld_1", ref))

        const valid = {
          id: `biz_${ulid()}`,
          name: "Direct Ltd",
          countryCode: "NG",
          currencyCode: "NGN",
          primaryLedger: ledger,
        } satisfies typeof businesses.$inferInsert

        const insert = (row: Partial<typeof businesses.$inferInsert>) =>
          Testing.attempt(database.use((db) => db.insert(businesses).values({ ...valid, ...row })))

        const update = (row: Partial<typeof businesses.$inferInsert>) =>
          Testing.attempt(database.use((db) => db.update(businesses).set(row).where(eq(businesses.id, business.id))))

        const rejected: ReadonlyArray<readonly [string, Partial<typeof businesses.$inferInsert>, string]> = [
          ["unlisted country", { countryCode: "GB" }, "businesses_country_code_valid"],
          ["three-letter country", { countryCode: "USA" }, "businesses_country_code_valid"],
          ["NG in USD", { currencyCode: "USD", primaryLedger: usd }, "businesses_currency_code_matches_country"],
          ["US in NGN", { countryCode: "US" }, "businesses_currency_code_matches_country"],
          ["holder alone", { ledgerHolderRef: "hld_2" }, "businesses_holder_with_account"],
          ["account alone", { primaryPayableAccountRef: `acct_${ulid()}` }, "businesses_holder_with_account"],
          ["active without account", { status: "active" }, "businesses_active_has_account"],
          ["ledger in another currency", { countryCode: "US", currencyCode: "USD" }, "businesses_primary_ledger_fk"],
          ["unknown ledger", { primaryLedger: "missing" }, "businesses_primary_ledger_fk"],
          ["another business's account", { ledgerHolderRef: "hld_2", primaryPayableAccountRef: ref }, "businesses_primary_payable_account_ref_unique"],
        ]

        for (const [reason, row, constraint] of rejected) {
          assert.equal(violated(yield* insert(row)), constraint, reason)
        }

        // Nor can an existing business be moved out of its currency, or
        // activated with its account cleared.
        assert.equal(violated(yield* update({ currencyCode: "USD" })), "businesses_currency_code_matches_country")
        assert.equal(
          violated(yield* update({ countryCode: "US", currencyCode: "USD" })),
          "businesses_primary_ledger_fk",
        )
        assert.equal(
          violated(yield* update({ status: "active", ledgerHolderRef: null, primaryPayableAccountRef: null })),
          "businesses_active_has_account",
        )

        // Omitting the country defaults it to Nigeria.
        const { countryCode: _omitted, ...withoutCountry } = valid

        assert.ok(
          Exit.isSuccess(yield* Testing.attempt(database.use((db) => db.insert(businesses).values(withoutCountry)))),
        )
      }),
    ),
  ))

void test("a business name must be trimmed, by the same rule in core and the database", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const database = yield* Database
        const { ledger } = yield* createBusiness()

        // What JavaScript trims, and some it doesn't: NEL, zero-width space,
        // and the Mongolian vowel separator, which Unicode no longer counts.
        const candidates = [
          "\t", "\n", "\v", "\f", "\r", " ", "\u00a0", "\u1680", "\u2000", "\u2007", "\u200a",
          "\u2028", "\u2029", "\u202f", "\u205f", "\u3000", "\ufeff", "\u0085", "\u200b", "\u180e",
        ]

        for (const character of candidates) {
          const code = `U+${character.codePointAt(0)?.toString(16).padStart(4, "0")}`
          const trims = (character + "x").trim() !== character + "x"

          assert.equal(Schema.is(Business.Details.fields.name)(`${character}Acme`), !trims, code)

          for (const [where, name] of [["leading", `${character}Acme`], ["trailing", `Acme${character}`]] as const) {
            const exit = yield* Testing.attempt(
              database.use((db) =>
                db.insert(businesses).values({
                  id: `biz_${ulid()}`,
                  name,
                  countryCode: "NG",
                  currencyCode: "NGN",
                  primaryLedger: ledger,
                }),
              ),
            )

            assert.equal(violated(exit), trims ? "businesses_name_trimmed" : undefined, `${where} ${code}`)
          }
        }
      }),
    ),
  ))

void test("the database rejects catalog rows that break the country defaults", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const database = yield* Database
        const { ledger } = yield* createBusiness()

        const insert = (row: typeof ledgers.$inferInsert) =>
          Testing.attempt(database.use((db) => db.insert(ledgers).values(row)))

        const slug = () => `ledger_${ulid().toLowerCase()}`

        assert.equal(
          violated(yield* insert({ slug: slug(), currency: "NGN", scale: 2, countryCode: "NG", isCountryDefault: true })),
          "ledgers_country_default_unique",
        )
        assert.equal(
          violated(yield* insert({ slug: slug(), currency: "NGN", scale: 2, isCountryDefault: true })),
          "ledgers_country_default_has_country",
        )
        assert.equal(
          violated(yield* insert({ slug: slug(), currency: "NGN", scale: 2, countryCode: "NGA" })),
          "ledgers_country_code_valid",
        )

        // A ledger in use can't change currency under its businesses.
        assert.equal(
          violated(
            yield* Testing.attempt(
              database.use((db) => db.update(ledgers).set({ currency: "USD" }).where(eq(ledgers.slug, ledger))),
            ),
          ),
          "businesses_currency_code_matches_country",
        )

        // A non-default ledger in a country with one is fine.
        assert.ok(Exit.isSuccess(yield* insert({ slug: slug(), currency: "NGN", scale: 2, countryCode: "NG" })))
      }),
    ),
  ))
