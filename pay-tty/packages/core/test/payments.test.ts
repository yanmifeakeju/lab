import assert from "node:assert/strict"
import { test } from "node:test"

import { eq } from "drizzle-orm"
import { Cause, Effect, Encoding, Exit, Predicate, Schema } from "effect"
import { ulid } from "ulid"

import { Business } from "../src/business/business.ts"
import { Database } from "../src/database/client.ts"
import { Payments } from "../src/payments/payments.ts"
import { paymentLinks } from "../src/payments/sql.ts"
import { Principal } from "../src/principal/principal.ts"
import { Testing } from "../src/testing/testing.ts"
import { runtime } from "./runtime.ts"

const createBusiness = Effect.gen(function* () {
  const principals = yield* Principal.Service
  const businesses = yield* Business.Service

  const principal = yield* principals.ensure({ issuer: "payments-test", subject: ulid() })

  return yield* businesses.create(principal.id, new Business.Details({ name: "Acme Ltd", countryCode: "NG" }))
})

const key = () => Payments.IdempotencyKey.make(`key_${ulid()}`)

const fixed = (amountMinor = 250_000n, title = "Consulting") =>
  new Payments.Details({ title, description: null, pricing: new Payments.Fixed({ amountMinor }) })

const chooses = (
  settings: Partial<Payments.Bounds> = {},
  description: string | null = "Help equip the library",
) =>
  new Payments.Details({
    title: "Community fundraiser",
    description,
    pricing: new Payments.CustomerChooses({
      suggestedAmountMinor: null,
      minimumAmountMinor: null,
      maximumAmountMinor: null,
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

void test("a fixed link is saved with the business's currency and scale, a reference, and a share token", () =>
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
        assert.equal(link.currencyCode, "NGN")
        assert.equal(link.scale, business.primaryLedger.scale)
        assert.deepEqual(link.pricing, new Payments.Fixed({ amountMinor: 250_000n }))
        assert.match(link.shareToken, /^[A-Za-z0-9_-]{43}$/)

        const [row, ...rest] = yield* rows(business.id)

        assert.equal(rest.length, 0)
        assert.equal(row?.id, link.id)
        assert.equal(row.shareToken, link.shareToken)
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
          new Payments.CustomerChooses({ suggestedAmountMinor: null, minimumAmountMinor: null, maximumAmountMinor: null }),
        )

        const settings: ReadonlyArray<Partial<Payments.Bounds>> = [
          { suggestedAmountMinor: 250_000n },
          { minimumAmountMinor: 100n },
          { maximumAmountMinor: 100n },
          { suggestedAmountMinor: 500n, minimumAmountMinor: 100n, maximumAmountMinor: 1_000n },
          { suggestedAmountMinor: 100n, minimumAmountMinor: 100n, maximumAmountMinor: 100n },
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
        const details = chooses({ suggestedAmountMinor: 500n, minimumAmountMinor: 100n })

        const first = yield* create(business.id, idempotencyKey, details)
        const repeat = yield* create(business.id, idempotencyKey, chooses({ suggestedAmountMinor: 500n, minimumAmountMinor: 100n }))

        assert.equal(repeat.created, false)
        assert.deepEqual(repeat.link, first.link)

        const changed = [
          chooses({ suggestedAmountMinor: 500n }),
          chooses({ suggestedAmountMinor: 500n, minimumAmountMinor: 100n, maximumAmountMinor: 900n }),
          chooses({ suggestedAmountMinor: 500n, minimumAmountMinor: 100n }, null),
          chooses({ suggestedAmountMinor: 500n, minimumAmountMinor: 100n }, "Another cause"),
          new Payments.Details({ title: "Another fundraiser", description: details.description, pricing: details.pricing }),
          fixed(500n, "Community fundraiser"),
        ]

        for (const other of changed) {
          assert.ok(yield* conflicts(create(business.id, idempotencyKey, other)))
        }

        const stored = yield* rows(business.id)

        assert.equal(stored.length, 1)
        assert.equal(stored[0]?.id, first.link.id)
        assert.equal(stored[0].minimumAmountMinor, 100n)
        assert.equal(stored[0].maximumAmountMinor, null)
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
        Array.from({ length: 8 }, (_, index) => Effect.exit(create(business.id, racing, fixed(BigInt(index + 1))))),
        { concurrency: "unbounded" },
      )

      assert.equal(outcomes.filter(Exit.isSuccess).length, 1)
      assert.equal(outcomes.filter((exit) => Exit.isFailure(exit) && !Cause.hasDies(exit.cause)).length, 7)
      assert.equal((yield* rows(business.id)).length, 2)
    }),
  ))

void test("details are validated before anything reaches the database", () => {
  const invalid: ReadonlyArray<readonly [string, () => object]> = [
    ["zero amount", () => new Payments.Fixed({ amountMinor: 0n })],
    ["negative amount", () => new Payments.Fixed({ amountMinor: -1n })],
    ["unsafe amount", () => new Payments.Fixed({ amountMinor: Payments.maxAmount + 1n })],
    ["zero suggestion", () => chooses({ suggestedAmountMinor: 0n })],
    ["inverted bounds", () => chooses({ minimumAmountMinor: 200n, maximumAmountMinor: 100n })],
    ["suggestion below the minimum", () => chooses({ suggestedAmountMinor: 99n, minimumAmountMinor: 100n })],
    ["suggestion above the maximum", () => chooses({ suggestedAmountMinor: 101n, maximumAmountMinor: 100n })],
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

  assert.doesNotThrow(() => new Payments.Fixed({ amountMinor: Payments.maxAmount }))
  assert.doesNotThrow(() => fixed(1n, "x".repeat(255)))
  assert.doesNotThrow(() => chooses({}, "x".repeat(500)))

  assert.deepEqual(
    Payments.boundsViolation({ suggestedAmountMinor: 50n, minimumAmountMinor: 100n, maximumAmountMinor: 10n }),
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

        const token = () => Encoding.encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)))

        const valid = () =>
          ({
            id: `plink_${ulid()}`,
            businessId: business.id,
            idempotencyKey: `key_${ulid()}`,
            shareToken: token(),
            title: "Direct",
            description: null,
            currencyCode: "NGN",
            scale: 2,
            pricingMode: "customer_chooses",
            amountMinor: null,
            suggestedAmountMinor: null,
            minimumAmountMinor: null,
            maximumAmountMinor: null,
          }) satisfies typeof paymentLinks.$inferInsert

        const insert = (row: Partial<typeof paymentLinks.$inferInsert>) =>
          Testing.attempt(database.use((db) => db.insert(paymentLinks).values({ ...valid(), ...row })))

        const max = Payments.maxAmount

        const rejected: ReadonlyArray<readonly [string, Partial<typeof paymentLinks.$inferInsert>, string]> = [
          ["fixed without amount", { pricingMode: "fixed" }, "payment_links_pricing_settings"],
          ["fixed with a suggestion", { pricingMode: "fixed", amountMinor: 1n, suggestedAmountMinor: 1n }, "payment_links_pricing_settings"],
          ["fixed with a minimum", { pricingMode: "fixed", amountMinor: 1n, minimumAmountMinor: 1n }, "payment_links_pricing_settings"],
          ["fixed with a maximum", { pricingMode: "fixed", amountMinor: 1n, maximumAmountMinor: 1n }, "payment_links_pricing_settings"],
          ["customer chooses with an amount", { amountMinor: 1n }, "payment_links_pricing_settings"],
          ["zero amount", { pricingMode: "fixed", amountMinor: 0n }, "payment_links_amount_minor_valid"],
          ["unsafe amount", { pricingMode: "fixed", amountMinor: max + 1n }, "payment_links_amount_minor_valid"],
          ["negative suggestion", { suggestedAmountMinor: -1n }, "payment_links_suggested_amount_minor_valid"],
          ["zero minimum", { minimumAmountMinor: 0n }, "payment_links_minimum_amount_minor_valid"],
          ["unsafe maximum", { maximumAmountMinor: max + 1n }, "payment_links_maximum_amount_minor_valid"],
          ["inverted bounds", { minimumAmountMinor: 2n, maximumAmountMinor: 1n }, "payment_links_minimum_within_maximum"],
          ["suggestion below a lone minimum", { suggestedAmountMinor: 1n, minimumAmountMinor: 2n }, "payment_links_suggested_within_bounds"],
          ["suggestion above a lone maximum", { suggestedAmountMinor: 3n, maximumAmountMinor: 2n }, "payment_links_suggested_within_bounds"],
          ["suggestion outside both", { suggestedAmountMinor: 5n, minimumAmountMinor: 1n, maximumAmountMinor: 4n }, "payment_links_suggested_within_bounds"],
          ["blank title", { title: "" }, "payment_links_title_valid"],
          ["untrimmed title", { title: "Direct " }, "payment_links_title_valid"],
          ["long title", { title: "x".repeat(256) }, "payment_links_title_valid"],
          ["blank description", { description: "" }, "payment_links_description_valid"],
          ["untrimmed description", { description: " Direct" }, "payment_links_description_valid"],
          ["long description", { description: "x".repeat(501) }, "payment_links_description_valid"],
          ["key with a space", { idempotencyKey: "a b" }, "payment_links_idempotency_key_valid"],
          ["short token", { shareToken: "abc" }, "payment_links_share_token_valid"],
          ["token an SSH user name can't be", { shareToken: `-${"a".repeat(42)}` }, "payment_links_share_token_valid"],
          ["lowercase currency", { currencyCode: "ngn" }, "payment_links_currency_code_valid"],
          ["scale out of range", { scale: 5 }, "payment_links_scale_valid"],
          ["unknown business", { businessId: `biz_${ulid()}` }, "payment_links_business_id_businesses_id_fk"],
          ["reused key", { idempotencyKey: saved.idempotencyKey }, "payment_links_business_id_idempotency_key_unique"],
          ["reused token", { shareToken: saved.shareToken }, "payment_links_share_token_unique"],
          ["reused reference", { id: link.id }, "payment_links_pkey"],
        ]

        for (const [reason, row, constraint] of rejected) {
          assert.equal(violated(yield* insert(row)), constraint, reason)
        }

        const accepted: ReadonlyArray<readonly [string, Partial<typeof paymentLinks.$inferInsert>]> = [
          ["fixed at the maximum", { pricingMode: "fixed", amountMinor: max }],
          ["open amount", {}],
          ["lone suggestion", { suggestedAmountMinor: max }],
          ["suggestion at both bounds", { suggestedAmountMinor: 2n, minimumAmountMinor: 2n, maximumAmountMinor: 2n }],
          ["lone maximum", { maximumAmountMinor: 1n }],
        ]

        for (const [reason, row] of accepted) {
          assert.ok(Exit.isSuccess(yield* insert(row)), reason)
        }
      }),
    ),
  ))
