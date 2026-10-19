import assert from "node:assert/strict"
import { test } from "node:test"

import { eq } from "drizzle-orm"
import { Cause, DateTime, Effect, Exit, Predicate } from "effect"
import { ulid } from "ulid"

import { Business } from "../src/business/business.ts"
import { Database } from "../src/database/client.ts"
import { Payments } from "../src/payments/payments.ts"
import { paymentLinks, payments as paymentRows } from "../src/payments/sql.ts"
import { Principal } from "../src/principal/principal.ts"
import { Testing } from "../src/testing/testing.ts"
import { runtime } from "./runtime.ts"

const createBusiness = (name = "Adaeze Studio") =>
  Effect.gen(function* () {
    const principals = yield* Principal.Service
    const businesses = yield* Business.Service

    const principal = yield* principals.ensure({ issuer: "pay-test", subject: ulid() })

    return yield* businesses.create(principal.id, new Business.Details({ name, countryCode: "NG" }))
  })

const key = () => Payments.IdempotencyKey.make(`key_${ulid()}`)

const fixed = new Payments.Details({
  title: "Logo design",
  description: "Two concepts and one revision.",
  pricing: new Payments.Fixed({ amountMinor: 2_500_000n }),
})

const chooses = (bounds: Partial<Payments.Bounds> = {}) =>
  new Payments.Details({
    title: "Tip jar",
    description: null,
    pricing: new Payments.CustomerChooses({
      suggestedAmountMinor: null,
      minimumAmountMinor: null,
      maximumAmountMinor: null,
      ...bounds,
    }),
  })

// A link of a new business, ready to be paid.
const createLink = (details: Payments.Details = fixed) =>
  Effect.gen(function* () {
    const business = yield* createBusiness()
    const service = yield* Payments.Service

    const { link } = yield* service.createLink(business.id, key(), details)

    return link
  })

const start = (
  shareToken: string,
  idempotencyKey: Payments.IdempotencyKey,
  amountMinor: bigint | null = null,
) =>
  Effect.gen(function* () {
    const service = yield* Payments.Service

    return yield* service.startPayment(shareToken, idempotencyKey, amountMinor)
  })

const simulate = (shareToken: string, paymentId: string, outcome: Payments.Outcome) =>
  Effect.gen(function* () {
    const service = yield* Payments.Service

    return yield* service.simulate(shareToken, paymentId, outcome)
  })

const stored = (linkId: string) =>
  Effect.gen(function* () {
    const database = yield* Database

    return yield* database.use((db) => db.select().from(paymentRows).where(eq(paymentRows.linkId, linkId)))
  })

// The tag a failed effect failed with.
const failedWith = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.flip(effect), (error) => (Predicate.hasProperty(error, "_tag") ? error._tag : undefined))

// The constraint a failed query violated; pg's error is the cause Drizzle wraps.
const violated = <A, E>(exit: Exit.Exit<A, E>) => {
  if (Exit.isSuccess(exit)) {
    return undefined
  }

  const defect = Cause.squash(exit.cause)
  const error = defect instanceof Error && defect.cause instanceof Error ? defect.cause : undefined

  return error !== undefined && "constraint" in error ? error.constraint : undefined
}

const minutes = (from: Date, to: Date) => (to.getTime() - from.getTime()) / 60_000

void test("a share token finds its link with the business's name; an unknown one finds nothing", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const service = yield* Payments.Service
        const link = yield* createLink()

        const payable = yield* service.findLink(link.shareToken)

        assert.equal(payable.businessName, "Adaeze Studio")
        assert.deepEqual(payable.link, link)
        assert.equal(payable.link.deactivatedAt, null)

        assert.equal(yield* failedWith(service.findLink("x".repeat(43))), "Payments.LinkNotFoundError")
      }),
    ),
  ))

void test("a fixed-price payment charges the link's amount in its currency, pending for the payment window", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const link = yield* createLink()

        const { payment, created } = yield* start(link.shareToken, key())

        assert.equal(created, true)
        assert.match(payment.id, /^pay_[0-9A-HJKMNP-TV-Z]{26}$/)
        assert.equal(payment.linkId, link.id)
        assert.equal(payment.businessId, link.businessId)
        assert.equal(payment.amountMinor, 2_500_000n)
        assert.equal(payment.currencyCode, "NGN")
        assert.equal(payment.scale, 2)
        assert.equal(payment.status, "pending")
        assert.equal(payment.completedAt, null)
        assert.equal(minutes(payment.createdAt, payment.expiresAt), Payments.paymentWindowMinutes)

        // The link's own amount: the customer names none.
        assert.equal(yield* failedWith(start(link.shareToken, key(), 2_500_000n)), "Payments.AmountError")
      }),
    ),
  ))

void test("a customer-chosen payment needs an amount within the link's bounds", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const bounded = yield* createLink(chooses({ minimumAmountMinor: 100_000n, maximumAmountMinor: 500_000n }))
        const open = yield* createLink(chooses({ suggestedAmountMinor: 500_000n }))

        const reason = (shareToken: string, amount: bigint | null) =>
          Effect.map(Effect.flip(start(shareToken, key(), amount)), (error) =>
            Predicate.isTagged(error, "Payments.AmountError") ? error.reason : error._tag,
          )

        assert.equal(yield* reason(bounded.shareToken, null), "required")
        assert.equal(yield* reason(bounded.shareToken, 99_999n), "below_minimum")
        assert.equal(yield* reason(bounded.shareToken, 500_001n), "above_maximum")

        for (const amount of [100_000n, 250_000n, 500_000n]) {
          assert.equal((yield* start(bounded.shareToken, key(), amount)).payment.amountMinor, amount)
        }

        // A suggestion is no bound.
        assert.equal((yield* start(open.shareToken, key(), 1n)).payment.amountMinor, 1n)
        assert.equal((yield* start(open.shareToken, key(), Payments.maxAmount)).payment.amountMinor, Payments.maxAmount)

        assert.deepEqual(
          Payments.amountFor(new Payments.Fixed({ amountMinor: 5n }), null),
          Payments.amountFor(open.pricing, 5n),
        )
      }),
    ),
  ))

void test("one link takes many payments; a repeated key returns its payment and another amount conflicts", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const link = yield* createLink(chooses())
        const idempotencyKey = key()

        const first = yield* start(link.shareToken, idempotencyKey, 5_000n)
        const repeat = yield* start(link.shareToken, idempotencyKey, 5_000n)

        assert.equal(repeat.created, false)
        assert.deepEqual(repeat.payment, first.payment)

        assert.equal(yield* failedWith(start(link.shareToken, idempotencyKey, 6_000n)), "Payments.PaymentConflictError")

        for (const amount of [6_000n, 7_000n]) {
          yield* start(link.shareToken, key(), amount)
        }

        const rows = yield* stored(link.id)

        assert.equal(rows.length, 3)
        assert.deepEqual(rows.map((row) => row.amountMinor).sort((a, b) => (a < b ? -1 : 1)), [5_000n, 6_000n, 7_000n])
      }),
    ),
  ))

void test("a deactivated link starts no payment, but a repeat still returns the one it started", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const service = yield* Payments.Service
        const link = yield* createLink()
        const idempotencyKey = key()

        const { payment } = yield* start(link.shareToken, idempotencyKey)

        yield* Testing.deactivateLink(link.id)

        assert.notEqual((yield* service.findLink(link.shareToken)).link.deactivatedAt, null)
        assert.equal(yield* failedWith(start(link.shareToken, key())), "Payments.LinkInactiveError")
        assert.deepEqual((yield* start(link.shareToken, idempotencyKey)).payment, payment)

        // A payment already under way still completes.
        assert.equal((yield* simulate(link.shareToken, payment.id, "succeeded")).status, "succeeded")
      }),
    ),
  ))

void test("a simulated outcome ends a pending payment once; later outcomes are refused with how it ended", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const link = yield* createLink()

        for (const outcome of ["succeeded", "failed", "cancelled"] as const) {
          const { payment } = yield* start(link.shareToken, key())

          const ended = yield* simulate(link.shareToken, payment.id, outcome)

          assert.equal(ended.status, outcome)
          assert.ok(ended.completedAt !== null)
          assert.deepEqual(
            [ended.id, ended.amountMinor, ended.createdAt, ended.expiresAt],
            [payment.id, payment.amountMinor, payment.createdAt, payment.expiresAt],
          )

          for (const again of ["succeeded", "failed", "cancelled"] as const) {
            const refused = yield* Effect.flip(simulate(link.shareToken, payment.id, again))

            assert.deepEqual(Predicate.isTagged(refused, "Payments.PaymentClosedError") ? refused.payment : refused, ended)
          }
        }
      }),
    ),
  ))

void test("a payment is only reachable through its own link's token", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const link = yield* createLink()
        const other = yield* createLink()

        const { payment } = yield* start(link.shareToken, key())

        assert.equal(yield* failedWith(simulate(other.shareToken, payment.id, "succeeded")), "Payments.PaymentNotFoundError")
        assert.equal(yield* failedWith(simulate(link.shareToken, `pay_${ulid()}`, "succeeded")), "Payments.PaymentNotFoundError")
        assert.equal(yield* failedWith(simulate("x".repeat(43), payment.id, "succeeded")), "Payments.LinkNotFoundError")
        assert.equal(yield* failedWith(start("x".repeat(43), key())), "Payments.LinkNotFoundError")

        // Untouched by any of that.
        assert.equal((yield* stored(link.id))[0]?.status, "pending")
      }),
    ),
  ))

void test("a payment past its window is expired as of its expiry, not resolved", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const link = yield* createLink()
        const idempotencyKey = key()

        const { payment } = yield* start(link.shareToken, idempotencyKey)

        yield* Testing.lapsePayment(payment.id)

        const refused = yield* Effect.flip(simulate(link.shareToken, payment.id, "succeeded"))

        const expired = Predicate.isTagged(refused, "Payments.PaymentClosedError") ? refused.payment : undefined

        assert.equal(expired?.status, "expired")
        assert.deepEqual(expired?.completedAt, expired?.expiresAt)

        // Expiry is final, and a repeat of the key reports it.
        assert.deepEqual((yield* start(link.shareToken, idempotencyKey)).payment, expired)
        assert.equal(yield* failedWith(simulate(link.shareToken, payment.id, "cancelled")), "Payments.PaymentClosedError")
      }),
    ),
  ))

void test("a repeated start after the window reports the payment expired", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const link = yield* createLink()
        const idempotencyKey = key()

        const { payment } = yield* start(link.shareToken, idempotencyKey)

        yield* Testing.lapsePayment(payment.id)

        const repeat = yield* start(link.shareToken, idempotencyKey)

        assert.equal(repeat.created, false)
        assert.equal(repeat.payment.status, "expired")
      }),
    ),
  ))

// Committed, so each request runs on its own connection.
void test("concurrent identical starts settle on one payment, and concurrent outcomes on one", () =>
  runtime.runPromise(
    Effect.gen(function* () {
      const link = yield* createLink()
      const idempotencyKey = key()

      const results = yield* Effect.all(
        Array.from({ length: 8 }, () => start(link.shareToken, idempotencyKey)),
        { concurrency: "unbounded" },
      )

      assert.equal(new Set(results.map(({ payment }) => payment.id)).size, 1)
      assert.equal(results.filter(({ created }) => created).length, 1)

      const id = results[0]?.payment.id ?? ""

      const outcomes = yield* Effect.all(
        (["succeeded", "failed", "cancelled", "succeeded", "failed", "cancelled"] as const).map((outcome) =>
          Effect.exit(simulate(link.shareToken, id, outcome)),
        ),
        { concurrency: "unbounded" },
      )

      const landed = outcomes.filter(Exit.isSuccess)

      assert.equal(landed.length, 1)
      assert.equal((yield* stored(link.id))[0]?.status, landed[0]?.value.status)
    }),
  ))

void test("the database keeps a payment in its link's business, currency, and scale, and its status consistent", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const database = yield* Database
        const link = yield* createLink()
        const elsewhere = yield* createBusiness("Elsewhere Ltd")
        const now = DateTime.toDate(yield* DateTime.now)

        const valid = () =>
          ({
            id: `pay_${ulid()}`,
            businessId: link.businessId,
            linkId: link.id,
            idempotencyKey: `key_${ulid()}`,
            amountMinor: 100n,
            currencyCode: "NGN",
            scale: 2,
            status: "pending",
            createdAt: now,
            expiresAt: DateTime.toDate(DateTime.add(DateTime.fromDateUnsafe(now), { minutes: 30 })),
            completedAt: null,
          }) satisfies typeof paymentRows.$inferInsert

        const insert = (row: Partial<typeof paymentRows.$inferInsert>) =>
          Testing.attempt(database.use((db) => db.insert(paymentRows).values({ ...valid(), ...row })))

        const existing = valid()

        yield* database.use((db) => db.insert(paymentRows).values(existing))

        const rejected: ReadonlyArray<readonly [string, Partial<typeof paymentRows.$inferInsert>, string]> = [
          ["another business", { businessId: elsewhere.id }, "payments_link_fk"],
          ["another currency", { currencyCode: "USD" }, "payments_link_fk"],
          ["another scale", { scale: 0 }, "payments_link_fk"],
          ["unknown link", { linkId: `plink_${ulid()}` }, "payments_link_fk"],
          ["zero amount", { amountMinor: 0n }, "payments_amount_minor_valid"],
          ["unsafe amount", { amountMinor: Payments.maxAmount + 1n }, "payments_amount_minor_valid"],
          ["key with a space", { idempotencyKey: "a b" }, "payments_idempotency_key_valid"],
          ["expiry at creation", { expiresAt: now }, "payments_expires_after_created"],
          ["pending but completed", { completedAt: now }, "payments_completed_with_status"],
          ["ended but not completed", { status: "succeeded" }, "payments_completed_with_status"],
          ["reused key", { idempotencyKey: existing.idempotencyKey }, "payments_link_id_idempotency_key_unique"],
        ]

        for (const [reason, row, constraint] of rejected) {
          assert.equal(violated(yield* insert(row)), constraint, reason)
        }

        assert.ok(Exit.isSuccess(yield* insert({ status: "failed", completedAt: now })))

        // A link with payments can't be deleted.
        const removal = yield* Testing.attempt(
          database.use((db) => db.delete(paymentLinks).where(eq(paymentLinks.id, link.id))),
        )

        assert.equal(violated(removal), "payments_link_fk")
      }),
    ),
  ))
