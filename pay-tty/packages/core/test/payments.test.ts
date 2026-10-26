import assert from "node:assert/strict"
import { test } from "node:test"

import { eq, sql } from "drizzle-orm"
import { Cause, Effect, Encoding, Exit, Predicate, Schema } from "effect"
import { ulid } from "ulid"

import { Business } from "../src/business/business.ts"
import { businesses } from "../src/business/sql.ts"
import { Database } from "../src/database/client.ts"
import { ledgers } from "../src/ledger/sql.ts"
import { Payments } from "../src/payments/payments.ts"
import { paymentLinks, payments as paymentRows } from "../src/payments/sql.ts"
import { Principal } from "../src/principal/principal.ts"
import { Testing } from "../src/testing/testing.ts"
import { runtime } from "./runtime.ts"

const createBusiness = Effect.gen(function* () {
  const principals = yield* Principal.Service
  const businesses = yield* Business.Service

  const principal = yield* principals.ensure({ issuer: "payments-test", subject: ulid() })

  const business = yield* businesses.create(principal.id, new Business.Details({ name: "Acme Ltd", countryCode: "NG" }))

  yield* Testing.openAccount(business.id)

  return business
})

const key = () => Payments.IdempotencyKey.make(`key_${ulid()}`)

const fixed = (amount = 250_000n, title = "Consulting") =>
  new Payments.Details({ title, description: null, pricing: new Payments.Fixed({ amount }) })

const chooses = (
  settings: Partial<Payments.Bounds> = {},
  description: string | null = "Help equip the library",
) =>
  new Payments.Details({
    title: "Community fundraiser",
    description,
    pricing: new Payments.CustomerChooses({
      suggestedAmount: null,
      minimumAmount: null,
      maximumAmount: null,
      ...settings,
    }),
  })

const create = (businessId: Business.ID, idempotencyKey: Payments.IdempotencyKey, details: Payments.Details) =>
  Effect.gen(function* () {
    const payments = yield* Payments.Service

    return yield* payments.createLink(businessId, idempotencyKey, details)
  })

const rows = (businessId: string) =>
  Effect.gen(function* () {
    const database = yield* Database

    return yield* database.use((db) => db.select().from(paymentLinks).where(eq(paymentLinks.businessId, businessId)))
  })

const conflicts = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.flip(effect), Predicate.isTagged("Payments.ConflictError"))

// The constraint a failed query violated; pg's error is the cause Drizzle wraps.
const violated = <A, E>(exit: Exit.Exit<A, E>) => {
  if (Exit.isSuccess(exit)) {
    return undefined
  }

  const defect = Cause.squash(exit.cause)
  const error = defect instanceof Error && defect.cause instanceof Error ? defect.cause : undefined

  return error !== undefined && "constraint" in error ? error.constraint : undefined
}

// What the database said when a query failed.
const raised = <A, E>(exit: Exit.Exit<A, E>) => {
  if (Exit.isSuccess(exit)) {
    return undefined
  }

  const defect = Cause.squash(exit.cause)

  return defect instanceof Error && defect.cause instanceof Error ? defect.cause.message : undefined
}

void test("a fixed link is saved in the business's primary ledger, with a reference and a share token", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const business = yield* createBusiness
        const { link, created } = yield* create(business.id, key(), fixed())

        assert.equal(created, true)
        assert.match(link.id, /^plink_[0-9A-HJKMNP-TV-Z]{26}$/)
        assert.equal(link.businessId, business.id)
        assert.equal(link.title, "Consulting")
        assert.equal(link.description, null)
        assert.equal(link.ledger, business.primaryLedger.slug)
        assert.equal(link.currencyCode, "NGN")
        assert.equal(link.scale, business.primaryLedger.scale)
        assert.deepEqual(link.pricing, new Payments.Fixed({ amount: 250_000n }))
        assert.match(link.shareToken, /^[A-Za-z0-9_-]{43}$/)

        const [row, ...rest] = yield* rows(business.id)

        assert.equal(rest.length, 0)
        assert.equal(row?.id, link.id)
        assert.equal(row.shareToken, link.shareToken)
        assert.equal(row.ledger, business.primaryLedger.slug)
        assert.ok(!link.shareToken.includes(link.id.slice(6)), "the token is independent of the reference")
      }),
    ),
  ))

void test("a customer-chosen link may leave every setting unset, or set any of them", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const business = yield* createBusiness

        const open = yield* create(business.id, key(), chooses({}, null))

        assert.deepEqual(
          open.link.pricing,
          new Payments.CustomerChooses({ suggestedAmount: null, minimumAmount: null, maximumAmount: null }),
        )

        const settings: ReadonlyArray<Partial<Payments.Bounds>> = [
          { suggestedAmount: 250_000n },
          { minimumAmount: 100n },
          { maximumAmount: 100n },
          { suggestedAmount: 500n, minimumAmount: 100n, maximumAmount: 1_000n },
          { suggestedAmount: 100n, minimumAmount: 100n, maximumAmount: 100n },
        ]

        for (const setting of settings) {
          const { link } = yield* create(business.id, key(), chooses(setting))

          assert.equal(link.description, "Help equip the library")
          assert.deepEqual(link.pricing, chooses(setting).pricing)
        }

        assert.equal((yield* rows(business.id)).length, settings.length + 1)
      }),
    ),
  ))

void test("an identical repeat returns the saved link; other details conflict and change nothing", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const business = yield* createBusiness
        const idempotencyKey = key()
        const details = chooses({ suggestedAmount: 500n, minimumAmount: 100n })

        const first = yield* create(business.id, idempotencyKey, details)
        const repeat = yield* create(business.id, idempotencyKey, chooses({ suggestedAmount: 500n, minimumAmount: 100n }))

        assert.equal(repeat.created, false)
        assert.deepEqual(repeat.link, first.link)

        const changed = [
          chooses({ suggestedAmount: 500n }),
          chooses({ suggestedAmount: 500n, minimumAmount: 100n, maximumAmount: 900n }),
          chooses({ suggestedAmount: 500n, minimumAmount: 100n }, null),
          chooses({ suggestedAmount: 500n, minimumAmount: 100n }, "Another cause"),
          new Payments.Details({ title: "Another fundraiser", description: details.description, pricing: details.pricing }),
          fixed(500n, "Community fundraiser"),
        ]

        for (const other of changed) {
          assert.ok(yield* conflicts(create(business.id, idempotencyKey, other)))
        }

        const stored = yield* rows(business.id)

        assert.equal(stored.length, 1)
        assert.equal(stored[0]?.id, first.link.id)
        assert.equal(stored[0].minimumAmount, 100n)
        assert.equal(stored[0].maximumAmount, null)
      }),
    ),
  ))

void test("a key is scoped to its business", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const first = yield* createBusiness
        const second = yield* createBusiness
        const idempotencyKey = key()

        const ours = yield* create(first.id, idempotencyKey, fixed())
        const theirs = yield* create(second.id, idempotencyKey, fixed(100n))

        assert.equal(theirs.created, true)
        assert.notEqual(theirs.link.id, ours.link.id)
        assert.notEqual(theirs.link.shareToken, ours.link.shareToken)
        assert.deepEqual((yield* rows(first.id)).map((row) => row.id), [ours.link.id])
        assert.deepEqual((yield* rows(second.id)).map((row) => row.id), [theirs.link.id])
      }),
    ),
  ))

void test("no link setting is below one whole unit of the ledger's currency", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const business = yield* createBusiness

        const refused = (details: Payments.Details) =>
          Effect.map(Effect.flip(create(business.id, key(), details)), (error) =>
            Predicate.isTagged(error, "Payments.DetailsError") ? [error.field, error.message] : error._tag,
          )

        assert.deepEqual(yield* refused(fixed(99n)), ["amount", "must be at least ₦1.00"])
        assert.equal((yield* create(business.id, key(), fixed(100n))).link.pricing.mode, "fixed")

        for (const field of ["suggestedAmount", "minimumAmount", "maximumAmount"] as const) {
          assert.deepEqual(yield* refused(chooses({ [field]: 99n })), [field, "must be at least ₦1.00"])

          const { link } = yield* create(business.id, key(), chooses({ [field]: 100n }))

          assert.deepEqual(link.pricing, chooses({ [field]: 100n }).pricing)
        }

        assert.equal((yield* rows(business.id)).length, 4)
      }),
    ),
  ))

void test("a ledger keeps its currency and scale, but a new slug reaches its links and payments", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const database = yield* Database
        const service = yield* Payments.Service
        const slug = `ngn_${ulid().toLowerCase()}`

        // A business of its own, so renaming the ledger touches no other test's rows.
        yield* Testing.addLedger(slug, "NGN", 2)

        const businessId = Business.ID.make(`biz_${ulid()}`)

        yield* database.use((db) =>
          db.insert(businesses).values({
            id: businessId,
            name: "Renamed Ledger Ltd",
            countryCode: "NG",
            currencyCode: "NGN",
            primaryLedger: slug,
          }),
        )
        yield* Testing.openAccount(businessId)

        const { link } = yield* create(businessId, key(), fixed())
        const { payment } = yield* service.startPayment(link.shareToken, key(), null)

        assert.equal(payment.ledger, slug)

        const changes: ReadonlyArray<readonly [string, Partial<typeof ledgers.$inferInsert>]> = [
          ["currency", { currency: "USD" }],
          ["scale", { scale: 0 }],
        ]

        for (const [reason, change] of changes) {
          const exit = yield* Testing.attempt(
            database.use((db) => db.update(ledgers).set(change).where(eq(ledgers.slug, slug))),
          )

          assert.equal(raised(exit), `ledger ${slug} cannot change its currency or scale`, reason)
        }

        // Unchanged values pass.
        yield* database.use((db) => db.update(ledgers).set({ currency: "NGN", scale: 2 }).where(eq(ledgers.slug, slug)))

        const renamed = `${slug}_renamed`

        yield* database.use((db) => db.update(ledgers).set({ slug: renamed }).where(eq(ledgers.slug, slug)))

        const payable = yield* service.findLink(link.shareToken)

        const stored = yield* database.use((db) =>
          db.select({ ledger: paymentRows.ledger }).from(paymentRows).where(eq(paymentRows.id, payment.id)),
        )

        assert.equal(payable.link.ledger, renamed)
        assert.equal(payable.link.currencyCode, "NGN")
        assert.deepEqual(stored, [{ ledger: renamed }])
      }),
    ),
  ))

void test("an unknown business is not found, and nothing is saved", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const missing = Business.ID.make(`biz_${ulid()}`)

        const error = yield* Effect.flip(create(missing, key(), fixed()))

        assert.ok(Predicate.isTagged(error, "Business.NotFoundError"))
        assert.equal((yield* rows(missing)).length, 0)
      }),
    ),
  ))

void test("a business whose account isn't open yet gets no link, and nothing is saved", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const principals = yield* Principal.Service
        const businesses = yield* Business.Service
        const principal = yield* principals.ensure({ issuer: "payments-test", subject: ulid() })
        const business = yield* businesses.create(principal.id, new Business.Details({ name: "Acme Ltd", countryCode: "NG" }))

        const error = yield* Effect.flip(create(business.id, key(), fixed()))

        assert.ok(Predicate.isTagged(error, "Payments.InactiveBusinessError"))
        assert.equal((yield* rows(business.id)).length, 0)
      }),
    ),
  ))

// Committed, so each request runs on its own connection.
void test("concurrent identical creates settle on one link", () =>
  runtime.runPromise(
    Effect.gen(function* () {
      const business = yield* createBusiness
      const idempotencyKey = key()

      const results = yield* Effect.all(
        Array.from({ length: 8 }, () => create(business.id, idempotencyKey, fixed())),
        { concurrency: "unbounded" },
      )

      assert.equal(new Set(results.map(({ link }) => link.id)).size, 1)
      assert.equal(results.filter(({ created }) => created).length, 1)
      assert.equal((yield* rows(business.id)).length, 1)

      // Racing different details, one wins and the rest conflict.
      const racing = key()

      const outcomes = yield* Effect.all(
        Array.from({ length: 8 }, (_, index) => Effect.exit(create(business.id, racing, fixed(BigInt((index + 1) * 100))))),
        { concurrency: "unbounded" },
      )

      assert.equal(outcomes.filter(Exit.isSuccess).length, 1)
      assert.equal(outcomes.filter((exit) => Exit.isFailure(exit) && !Cause.hasDies(exit.cause)).length, 7)
      assert.equal((yield* rows(business.id)).length, 2)
    }),
  ))

void test("details are validated before anything reaches the database", () => {
  const invalid: ReadonlyArray<readonly [string, () => object]> = [
    ["zero amount", () => new Payments.Fixed({ amount: 0n })],
    ["negative amount", () => new Payments.Fixed({ amount: -1n })],
    ["unsafe amount", () => new Payments.Fixed({ amount: Payments.maxAmount + 1n })],
    ["zero suggestion", () => chooses({ suggestedAmount: 0n })],
    ["inverted bounds", () => chooses({ minimumAmount: 200n, maximumAmount: 100n })],
    ["suggestion below the minimum", () => chooses({ suggestedAmount: 99n, minimumAmount: 100n })],
    ["suggestion above the maximum", () => chooses({ suggestedAmount: 101n, maximumAmount: 100n })],
    ["blank title", () => fixed(1n, "")],
    ["untrimmed title", () => fixed(1n, " Consulting")],
    ["long title", () => fixed(1n, "x".repeat(256))],
    ["blank description", () => chooses({}, "")],
    ["untrimmed description", () => chooses({}, "Help ")],
    ["long description", () => chooses({}, "x".repeat(501))],
  ]

  for (const [reason, make] of invalid) {
    assert.throws(make, reason)
  }

  assert.doesNotThrow(() => new Payments.Fixed({ amount: Payments.maxAmount }))
  assert.doesNotThrow(() => fixed(1n, "x".repeat(255)))
  assert.doesNotThrow(() => chooses({}, "x".repeat(500)))

  assert.deepEqual(
    Payments.boundsViolation({ suggestedAmount: 50n, minimumAmount: 100n, maximumAmount: 10n }),
    { setting: "maximum", message: "the maximum must be at least the minimum" },
  )

  for (const valid of ["k", "~".repeat(255), "0b9f3c52-7c1e-4a8e-9d2f-5a4b3c2d1e0f"]) {
    assert.ok(Schema.is(Payments.IdempotencyKey)(valid), valid)
  }

  for (const invalidKey of ["", " ", "a b", "x".repeat(256), "café", "a\tb"]) {
    assert.ok(!Schema.is(Payments.IdempotencyKey)(invalidKey), JSON.stringify(invalidKey))
  }
})

void test("the database enforces the pricing settings, bounds, and uniqueness itself", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const database = yield* Database
        const business = yield* createBusiness
        const { link } = yield* create(business.id, key(), fixed())

        const [saved] = yield* rows(business.id)

        assert.ok(saved !== undefined)

        // Never led by "-", which the share token check refuses.
        const token = () => `t${Encoding.encodeBase64Url(crypto.getRandomValues(new Uint8Array(32))).slice(1)}`

        const valid = () =>
          ({
            id: `plink_${ulid()}`,
            businessId: business.id,
            idempotencyKey: `key_${ulid()}`,
            shareToken: token(),
            title: "Direct",
            description: null,
            ledger: business.primaryLedger.slug,
            pricingMode: "customer_chooses",
            amount: null,
            suggestedAmount: null,
            minimumAmount: null,
            maximumAmount: null,
          }) satisfies typeof paymentLinks.$inferInsert

        const insert = (row: Partial<typeof paymentLinks.$inferInsert>) =>
          Testing.attempt(database.use((db) => db.insert(paymentLinks).values({ ...valid(), ...row })))

        const max = Payments.maxAmount

        const rejected: ReadonlyArray<readonly [string, Partial<typeof paymentLinks.$inferInsert>, string]> = [
          ["fixed without amount", { pricingMode: "fixed" }, "payment_links_pricing_settings"],
          ["fixed with a suggestion", { pricingMode: "fixed", amount: 1n, suggestedAmount: 1n }, "payment_links_pricing_settings"],
          ["fixed with a minimum", { pricingMode: "fixed", amount: 1n, minimumAmount: 1n }, "payment_links_pricing_settings"],
          ["fixed with a maximum", { pricingMode: "fixed", amount: 1n, maximumAmount: 1n }, "payment_links_pricing_settings"],
          ["customer chooses with an amount", { amount: 1n }, "payment_links_pricing_settings"],
          ["zero amount", { pricingMode: "fixed", amount: 0n }, "payment_links_amount_valid"],
          ["unsafe amount", { pricingMode: "fixed", amount: max + 1n }, "payment_links_amount_valid"],
          ["negative suggestion", { suggestedAmount: -1n }, "payment_links_suggested_amount_valid"],
          ["zero minimum", { minimumAmount: 0n }, "payment_links_minimum_amount_valid"],
          ["unsafe maximum", { maximumAmount: max + 1n }, "payment_links_maximum_amount_valid"],
          ["inverted bounds", { minimumAmount: 2n, maximumAmount: 1n }, "payment_links_minimum_within_maximum"],
          ["suggestion below a lone minimum", { suggestedAmount: 1n, minimumAmount: 2n }, "payment_links_suggested_within_bounds"],
          ["suggestion above a lone maximum", { suggestedAmount: 3n, maximumAmount: 2n }, "payment_links_suggested_within_bounds"],
          ["suggestion outside both", { suggestedAmount: 5n, minimumAmount: 1n, maximumAmount: 4n }, "payment_links_suggested_within_bounds"],
          ["blank title", { title: "" }, "payment_links_title_valid"],
          ["untrimmed title", { title: "Direct " }, "payment_links_title_valid"],
          ["long title", { title: "x".repeat(256) }, "payment_links_title_valid"],
          ["blank description", { description: "" }, "payment_links_description_valid"],
          ["untrimmed description", { description: " Direct" }, "payment_links_description_valid"],
          ["long description", { description: "x".repeat(501) }, "payment_links_description_valid"],
          ["key with a space", { idempotencyKey: "a b" }, "payment_links_idempotency_key_valid"],
          ["short token", { shareToken: "abc" }, "payment_links_share_token_valid"],
          ["token an SSH user name can't be", { shareToken: `-${"a".repeat(42)}` }, "payment_links_share_token_valid"],
          ["another ledger", { ledger: "usd_us" }, "payment_links_business_ledger_fk"],
          ["unknown business", { businessId: `biz_${ulid()}` }, "payment_links_business_id_businesses_id_fk"],
          ["reused key", { idempotencyKey: saved.idempotencyKey }, "payment_links_business_id_idempotency_key_unique"],
          ["reused token", { shareToken: saved.shareToken }, "payment_links_share_token_unique"],
          ["reused reference", { id: link.id }, "payment_links_pkey"],
        ]

        for (const [reason, row, constraint] of rejected) {
          assert.equal(violated(yield* insert(row)), constraint, reason)
        }

        const accepted: ReadonlyArray<readonly [string, Partial<typeof paymentLinks.$inferInsert>]> = [
          ["fixed at the maximum", { pricingMode: "fixed", amount: max }],
          ["open amount", {}],
          ["lone suggestion", { suggestedAmount: max }],
          ["suggestion at both bounds", { suggestedAmount: 2n, minimumAmount: 2n, maximumAmount: 2n }],
          ["lone maximum", { maximumAmount: 1n }],
        ]

        for (const [reason, row] of accepted) {
          assert.ok(Exit.isSuccess(yield* insert(row)), reason)
        }
      }),
    ),
  ))


void test("payments page newest first without losing equal or microsecond timestamps, scoped to the business and link", () =>
  runtime.runPromise(Testing.rolledBack(Effect.gen(function* () {
    const service = yield* Payments.Service
    const database = yield* Database
    const business = yield* createBusiness
    const other = yield* createBusiness
    const { link } = yield* create(business.id, key(), fixed())
    const second = (yield* create(business.id, key(), fixed(100n, "Other link"))).link
    const foreign = (yield* create(other.id, key(), fixed())).link

    const insert = (link: Payments.Link, count: number) => database.use((db) =>
      db.insert(paymentRows).values(Array.from({ length: count }, (_, index) => ({
        id: `pay_${ulid()}`,
        businessId: link.businessId,
        linkId: link.id,
        idempotencyKey: key(),
        amount: 100n,
        ledger: link.ledger,
        createdAt: index < 49 ? sql`now() - interval '1 second' + interval '0.123456 second'`
          : sql`now() - interval '1 second' + interval '0.123455 second'`,
        expiresAt: sql`now() + interval '30 minutes'`,
      }))).returning())

    const ours = yield* insert(link, 107)

    yield* insert(second, 1)
    yield* insert(foreign, 3)

    const seen: Array<string> = []
    let before: Payments.Cursor | null = null

    do {
      const page: Payments.PaymentPage = yield* service.listPayments(business.id, { linkId: link.id, state: null, before })

      assert.equal(page.stats.pending, 107, "totals ignore the cursor")
      assert.ok(page.payments.every((payment) => payment.source.title === link.title))
      seen.push(...page.payments.map((payment) => payment.id))
      before = page.next
    } while (before !== null)

    assert.equal(seen.length, 107)
    assert.equal(new Set(seen).size, 107)

    // The Date representation loses the microseconds, so check SQL order directly.
    const ordered = yield* database.use((db) => db.select({ id: paymentRows.id }).from(paymentRows)
      .where(eq(paymentRows.linkId, link.id)).orderBy(sql`${paymentRows.createdAt} desc, ${paymentRows.id} desc`))

    assert.equal(ours.length, seen.length)
    assert.deepEqual(seen, ordered.map((row) => row.id))

    const all = yield* service.listPayments(business.id, { linkId: null, state: null, before: null })

    assert.equal(all.stats.pending, 108)
    assert.ok(all.payments.every((payment) => payment.businessId === business.id))
    assert.ok(Predicate.isTagged(yield* Effect.flip(service.listPayments(business.id, {
      linkId: foreign.id, state: null, before: null,
    })), "Payments.LinkNotFoundError"))
  }))))

void test("effective expiry agrees across rows, filters and totals, and malformed cursors are refused", () =>
  runtime.runPromise(Testing.rolledBack(Effect.gen(function* () {
    const service = yield* Payments.Service
    const database = yield* Database
    const business = yield* createBusiness
    const { link } = yield* create(business.id, key(), fixed())
    const pending = (yield* service.startPayment(link.shareToken, key(), null)).payment
    const expired = (yield* service.startPayment(link.shareToken, key(), null)).payment
    const paid = (yield* service.startPayment(link.shareToken, key(), null)).payment

    yield* service.simulate(link.shareToken, paid.id, "succeeded")
    yield* database.use((db) => db.update(paymentRows).set({
      createdAt: sql`now() - interval '1 hour'`,
      expiresAt: sql`now() - interval '1 minute'`,
    }).where(eq(paymentRows.id, expired.id)))

    for (const state of [null, "pending", "expired", "settling", "failed", "cancelled"] as const) {
      const page = yield* service.listPayments(business.id, { linkId: null, state, before: null })

      assert.equal(page.next, null)
      assert.equal(page.stats.pending, page.payments.filter((payment) => payment.state === "pending").length)
      assert.equal(page.stats.expired, page.payments.filter((payment) => payment.state === "expired").length)
      assert.equal(page.stats.settling, page.payments.filter((payment) => payment.state === "settling").length)
      assert.equal(page.stats.settlingAmount, state === null || state === "settling" ? paid.amount : 0n)
      assert.equal(page.stats.collected, 0n)

      if (state === "pending") {
        assert.deepEqual(page.payments.map((payment) => payment.id), [pending.id])
      }

      if (state === "expired") {
        assert.deepEqual(page.payments.map((payment) => [payment.id, payment.status]), [[expired.id, "expired"]])
      }
    }

    for (const before of ["!", Encoding.encodeBase64Url("{}"), Encoding.encodeBase64Url('{"at":"2026-02-30 12:00:00+00","id":"pay_bad"}')]) {
      assert.ok(Predicate.isTagged(yield* Effect.flip(service.listPayments(business.id, {
        linkId: null, state: null, before: Payments.Cursor.make(before),
      })), "Payments.CursorError"))
    }
  }))))

void test("expired filters isolate both the business and the link, including overdue pending payments", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const service = yield* Payments.Service
        const database = yield* Database
        const business = yield* createBusiness
        const other = yield* createBusiness
        const { link } = yield* create(business.id, key(), fixed())
        const sibling = (yield* create(business.id, key(), fixed())).link
        const foreign = (yield* create(other.id, key(), fixed())).link

        const expire = Effect.fnUntraced(function* (link: Payments.Link) {
          const { payment } = yield* service.startPayment(link.shareToken, key(), null)

          yield* database.use((db) =>
            db.update(paymentRows)
              .set({
                createdAt: sql`now() - interval '1 hour'`,
                expiresAt: sql`now() - interval '1 minute'`,
              })
              .where(eq(paymentRows.id, payment.id)),
          )

          return payment.id
        })

        const own = yield* expire(link)
        const sameBusiness = yield* expire(sibling)
        const otherBusiness = yield* expire(foreign)

        for (const linkId of [null, link.id]) {
          const page = yield* service.listPayments(business.id, {
            linkId,
            state: "expired",
            before: null,
          })

          const expected = linkId === null ? [own, sameBusiness] : [own]

          assert.deepEqual(new Set(page.payments.map((payment) => payment.id)), new Set(expected))
          assert.equal(page.stats.expired, expected.length)
          assert.equal(page.stats.pending, 0)
          assert.ok(page.payments.every((payment) => payment.businessId === business.id))
          assert.ok(!page.payments.some((payment) => payment.id === otherBusiness))
        }
      }),
    ),
  ))
