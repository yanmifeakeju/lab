import { and, eq, gt, lte, sql } from "drizzle-orm"
import { Context, Effect, Encoding, Layer, Result, Schema } from "effect"

import { Business } from "../business/business.ts"
import { businesses } from "../business/sql.ts"
import { Database } from "../database/client.ts"
import { createId } from "../database/ids.ts"
import { Currency } from "../ledger/currency.ts"
import { ledgers } from "../ledger/sql.ts"
import { maxAmount, paymentLinks, payments, paymentStatuses } from "./sql.ts"

export { maxAmount } from "./sql.ts"

/** How long a payment stays pending before it expires. */
export const paymentWindowMinutes = 30

export const ID = Schema.String.pipe(
  Schema.check(Schema.isStartsWith("plink_")),
  Schema.brand("Payments.ID"),
)

export type ID = typeof ID.Type

/** Printable ASCII without spaces, so it travels in a header unchanged. */
export const IdempotencyKey = Schema.String.check(
  Schema.isPattern(/^[!-~]{1,255}$/).annotate({ expected: "1 to 255 printable ASCII characters without spaces" }),
).pipe(Schema.brand("Payments.IdempotencyKey"))

export type IdempotencyKey = typeof IdempotencyKey.Type

/** Minor units at the link's scale. */
export const Amount = Schema.BigInt.check(
  Schema.isGreaterThanBigInt(0n),
  Schema.isLessThanOrEqualToBigInt(maxAmount),
)

export const Title = Schema.NonEmptyString.check(Schema.isTrimmed(), Schema.isMaxLength(255))

export const Description = Schema.NonEmptyString.check(Schema.isTrimmed(), Schema.isMaxLength(500))

export class Fixed extends Schema.Class<Fixed>("Payments.Fixed")({
  mode: Schema.tag("fixed"),
  amountMinor: Amount,
}) {}

export interface Bounds {
  readonly suggestedAmountMinor: bigint | null
  readonly minimumAmountMinor: bigint | null
  readonly maximumAmountMinor: bigint | null
}

/** The setting that breaks the bounds and why, or undefined when they hold. */
export const boundsViolation = (
  bounds: Bounds,
): { readonly setting: "suggested" | "maximum"; readonly message: string } | undefined => {
  const { suggestedAmountMinor: suggested, minimumAmountMinor: minimum, maximumAmountMinor: maximum } = bounds

  if (minimum !== null && maximum !== null && minimum > maximum) {
    return { setting: "maximum", message: "the maximum must be at least the minimum" }
  }

  if (suggested !== null && minimum !== null && suggested < minimum) {
    return { setting: "suggested", message: "the suggested amount must be at least the minimum" }
  }

  if (suggested !== null && maximum !== null && suggested > maximum) {
    return { setting: "suggested", message: "the suggested amount must be at most the maximum" }
  }

  return undefined
}

// Every setting may be unset: the payer then chooses any amount.
export class CustomerChooses extends Schema.Class<CustomerChooses>("Payments.CustomerChooses")(
  Schema.Struct({
    mode: Schema.tag("customer_chooses"),
    suggestedAmountMinor: Schema.NullOr(Amount),
    minimumAmountMinor: Schema.NullOr(Amount),
    maximumAmountMinor: Schema.NullOr(Amount),
  }).check(
    Schema.makeFilter((bounds) => {
      const violation = boundsViolation(bounds)

      return violation === undefined
        ? undefined
        : { path: [`${violation.setting}AmountMinor`], issue: violation.message }
    }),
  ),
) {}

export const Pricing = Schema.Union([Fixed, CustomerChooses])

export type Pricing = typeof Pricing.Type

/** What a merchant submits; a repeat is compared with it field by field. */
export class Details extends Schema.Class<Details>("Payments.Details")({
  title: Title,
  description: Schema.NullOr(Description),
  pricing: Pricing,
}) {}

export class Link extends Schema.Class<Link>("Payments.Link")({
  id: ID,
  businessId: Business.ID,
  title: Schema.String,
  description: Schema.NullOr(Schema.String),
  currencyCode: Currency.Code,
  scale: Schema.Int,
  pricing: Pricing,
  /** Opaque and unguessable; the public link is served by it. */
  shareToken: Schema.String,
  /** Null while the link takes payments. */
  deactivatedAt: Schema.NullOr(Schema.Date),
  createdAt: Schema.Date,
}) {}

/** A link as its customers see it, with the name of the business it pays. */
export class Payable extends Schema.Class<Payable>("Payments.Payable")({
  link: Link,
  businessName: Schema.String,
}) {}

export const PaymentID = Schema.String.pipe(
  Schema.check(Schema.isStartsWith("pay_")),
  Schema.brand("Payments.PaymentID"),
)

export type PaymentID = typeof PaymentID.Type

export const Status = Schema.Literals(paymentStatuses)

export type Status = typeof Status.Type

/** What a simulated payment can end in; expiry is the clock's, not a choice. */
export const Outcome = Schema.Literals(["succeeded", "failed", "cancelled"])

export type Outcome = typeof Outcome.Type

export class Payment extends Schema.Class<Payment>("Payments.Payment")({
  id: PaymentID,
  linkId: ID,
  businessId: Business.ID,
  amountMinor: Schema.BigInt,
  currencyCode: Currency.Code,
  scale: Schema.Int,
  status: Status,
  createdAt: Schema.Date,
  expiresAt: Schema.Date,
  /** When it left pending; null while pending. */
  completedAt: Schema.NullOr(Schema.Date),
}) {}

export interface Started {
  readonly payment: Payment
  /** False when the key had already started this payment. */
  readonly created: boolean
}

export interface Created {
  readonly link: Link
  /** False when the key had already created this link. */
  readonly created: boolean
}

/** The key already created a link with other details; that link is unchanged. */
export class ConflictError extends Schema.TaggedError<ConflictError>()(
  "Payments.ConflictError",
  { businessId: Business.ID, existing: ID },
) {}

/** No link has this share token. */
export class LinkNotFoundError extends Schema.TaggedError<LinkNotFoundError>()("Payments.LinkNotFoundError", {}) {}

/** The link was deactivated, so it starts no new payments. */
export class LinkInactiveError extends Schema.TaggedError<LinkInactiveError>()(
  "Payments.LinkInactiveError",
  { id: ID },
) {}

/** The requested amount doesn't fit the link's pricing. */
export class AmountError extends Schema.TaggedError<AmountError>()("Payments.AmountError", {
  reason: Schema.Literals(["required", "unexpected", "below_minimum", "above_maximum"]),
  message: Schema.String,
}) {}

/** The key already started a payment for another amount; that payment is unchanged. */
export class PaymentConflictError extends Schema.TaggedError<PaymentConflictError>()(
  "Payments.PaymentConflictError",
  { linkId: ID, existing: PaymentID },
) {}

/** The link has no payment with this ID. */
export class PaymentNotFoundError extends Schema.TaggedError<PaymentNotFoundError>()(
  "Payments.PaymentNotFoundError",
  { linkId: ID, id: Schema.String },
) {}

/** The payment already left pending, as it now stands. */
export class PaymentClosedError extends Schema.TaggedError<PaymentClosedError>()(
  "Payments.PaymentClosedError",
  { payment: Payment },
) {}

export interface Interface {
  /**
   * Saves a link in the business's currency and scale. Idempotent per
   * business and key: a repeat with the same details returns the saved link
   * as first created, and one with other details conflicts.
   */
  readonly createLink: (
    businessId: Business.ID,
    idempotencyKey: IdempotencyKey,
    details: Details,
  ) => Effect.Effect<Created, Business.NotFoundError | ConflictError>
  /** The link behind a share token, deactivated or not. */
  readonly findLink: (shareToken: string) => Effect.Effect<Payable, LinkNotFoundError>
  /**
   * Starts a pending payment that expires after `paymentWindowMinutes`.
   * Idempotent per link and key: a repeat with the same amount returns that
   * payment, even once the link is deactivated. The amount is null for a
   * fixed-price link, which charges its own.
   */
  readonly startPayment: (
    shareToken: string,
    idempotencyKey: IdempotencyKey,
    amountMinor: bigint | null,
  ) => Effect.Effect<
    Started,
    LinkNotFoundError | LinkInactiveError | AmountError | PaymentConflictError
  >
  /**
   * Ends a pending payment of the link with the outcome a simulated provider
   * reported. A payment past its expiry is expired instead, and refused.
   */
  readonly simulate: (
    shareToken: string,
    paymentId: string,
    outcome: Outcome,
  ) => Effect.Effect<Payment, LinkNotFoundError | PaymentNotFoundError | PaymentClosedError>
}

export class Service extends Context.Service<Service, Interface>()("Payments") {}

type Row = typeof paymentLinks.$inferSelect

const pricingOf = (row: Row): Pricing => {
  if (row.pricingMode === "fixed") {
    if (row.amountMinor === null) {
      throw new Error(`fixed payment link ${row.id} has no amount`)
    }

    return new Fixed({ amountMinor: row.amountMinor })
  }

  return new CustomerChooses({
    suggestedAmountMinor: row.suggestedAmountMinor,
    minimumAmountMinor: row.minimumAmountMinor,
    maximumAmountMinor: row.maximumAmountMinor,
  })
}

const fromRow = (row: Row) =>
  new Link({
    id: ID.make(row.id),
    businessId: Business.ID.make(row.businessId),
    title: row.title,
    description: row.description,
    currencyCode: Currency.Code.make(row.currencyCode),
    scale: row.scale,
    pricing: pricingOf(row),
    shareToken: row.shareToken,
    deactivatedAt: row.deactivatedAt,
    createdAt: row.createdAt,
  })

type PaymentRow = typeof payments.$inferSelect

const paymentOf = (row: PaymentRow) =>
  new Payment({
    id: PaymentID.make(row.id),
    linkId: ID.make(row.linkId),
    businessId: Business.ID.make(row.businessId),
    amountMinor: row.amountMinor,
    currencyCode: Currency.Code.make(row.currencyCode),
    scale: row.scale,
    status: row.status,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    completedAt: row.completedAt,
  })

/** The amount a payment of this pricing charges, or why the request can't have it. */
export const amountFor = (pricing: Pricing, requested: bigint | null): Result.Result<bigint, AmountError> => {
  if (pricing.mode === "fixed") {
    return requested === null
      ? Result.succeed(pricing.amountMinor)
      : Result.fail(new AmountError({ reason: "unexpected", message: "a fixed-price link charges its own amount" }))
  }

  if (requested === null) {
    return Result.fail(new AmountError({ reason: "required", message: "this link needs the amount to pay" }))
  }

  if (pricing.minimumAmountMinor !== null && requested < pricing.minimumAmountMinor) {
    return Result.fail(new AmountError({ reason: "below_minimum", message: "the amount must be at least the minimum" }))
  }

  if (pricing.maximumAmountMinor !== null && requested > pricing.maximumAmountMinor) {
    return Result.fail(new AmountError({ reason: "above_maximum", message: "the amount must be at most the maximum" }))
  }

  return Result.succeed(requested)
}

const columnsOf = (pricing: Pricing) =>
  pricing.mode === "fixed"
    ? {
        pricingMode: pricing.mode,
        amountMinor: pricing.amountMinor,
        suggestedAmountMinor: null,
        minimumAmountMinor: null,
        maximumAmountMinor: null,
      }
    : {
        pricingMode: pricing.mode,
        amountMinor: null,
        suggestedAmountMinor: pricing.suggestedAmountMinor,
        minimumAmountMinor: pricing.minimumAmountMinor,
        maximumAmountMinor: pricing.maximumAmountMinor,
      }

// The submitted details only: currency and scale come from the server, and a
// repeat is answered with what was saved, whatever they are now.
const sameDetails = (row: Row, details: Details) => {
  const pricing = columnsOf(details.pricing)

  return (
    row.title === details.title &&
    row.description === details.description &&
    row.pricingMode === pricing.pricingMode &&
    row.amountMinor === pricing.amountMinor &&
    row.suggestedAmountMinor === pricing.suggestedAmountMinor &&
    row.minimumAmountMinor === pricing.minimumAmountMinor &&
    row.maximumAmountMinor === pricing.maximumAmountMinor
  )
}

// Customers use it as their SSH user name, which OpenSSH refuses when it
// starts with "-", so a token never does.
const shareToken = (): string => {
  const token = Encoding.encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)))

  return token.startsWith("-") ? shareToken() : token
}

const make = Effect.gen(function* () {
  const database = yield* Database

  const createLink = Effect.fn("Payments.createLink")(function* (
    businessId: Business.ID,
    idempotencyKey: IdempotencyKey,
    details: Details,
  ) {
    const owners = yield* database.use((db) =>
      db
        .select({ currency: ledgers.currency, scale: ledgers.scale })
        .from(businesses)
        .innerJoin(ledgers, eq(ledgers.slug, businesses.primaryLedger))
        .where(eq(businesses.id, businessId)),
    )

    const owner = owners[0]

    if (owner === undefined) {
      return yield* new Business.NotFoundError({ id: businessId })
    }

    // A concurrent insert with the same key waits on the unique index, and
    // whichever commits first is the link both return.
    const inserted = yield* database.use((db) =>
      db
        .insert(paymentLinks)
        .values({
          id: createId("plink"),
          businessId,
          idempotencyKey,
          shareToken: shareToken(),
          title: details.title,
          description: details.description,
          currencyCode: owner.currency,
          scale: owner.scale,
          ...columnsOf(details.pricing),
        })
        .onConflictDoNothing({ target: [paymentLinks.businessId, paymentLinks.idempotencyKey] })
        .returning(),
    )

    if (inserted[0] !== undefined) {
      return { link: fromRow(inserted[0]), created: true }
    }

    const existing = yield* database.use((db) =>
      db
        .select()
        .from(paymentLinks)
        .where(and(eq(paymentLinks.businessId, businessId), eq(paymentLinks.idempotencyKey, idempotencyKey))),
    )

    const row = existing[0]

    if (row === undefined) {
      return yield* Effect.die(new Error(`payment link for key vanished in ${businessId}`))
    }

    if (!sameDetails(row, details)) {
      return yield* new ConflictError({ businessId, existing: ID.make(row.id) })
    }

    return { link: fromRow(row), created: false }
  })

  const findLink = Effect.fn("Payments.findLink")(function* (shareToken: string) {
    const found = yield* database.use((db) =>
      db
        .select({ link: paymentLinks, businessName: businesses.name })
        .from(paymentLinks)
        .innerJoin(businesses, eq(businesses.id, paymentLinks.businessId))
        .where(eq(paymentLinks.shareToken, shareToken)),
    )

    const row = found[0]

    if (row === undefined) {
      return yield* new LinkNotFoundError()
    }

    return new Payable({ link: fromRow(row.link), businessName: row.businessName })
  })

  // A pending payment whose window has passed becomes expired, as of its expiry.
  const expireIfDue = (id: string) =>
    database.use((db) =>
      db
        .update(payments)
        .set({ status: "expired", completedAt: sql`${payments.expiresAt}` })
        .where(and(eq(payments.id, id), eq(payments.status, "pending"), lte(payments.expiresAt, sql`now()`)))
        .returning(),
    )

  const byKey = (linkId: string, idempotencyKey: IdempotencyKey) =>
    database.use((db) =>
      db
        .select()
        .from(payments)
        .where(and(eq(payments.linkId, linkId), eq(payments.idempotencyKey, idempotencyKey))),
    )

  // The payment a key already started, if the repeat asks for the same one.
  const repeated = Effect.fnUntraced(function* (row: PaymentRow, amountMinor: bigint) {
    if (row.amountMinor !== amountMinor) {
      return yield* new PaymentConflictError({ linkId: ID.make(row.linkId), existing: PaymentID.make(row.id) })
    }

    const expired = yield* expireIfDue(row.id)

    return { payment: paymentOf(expired[0] ?? row), created: false }
  })

  const startPayment = Effect.fn("Payments.startPayment")(function* (
    shareToken: string,
    idempotencyKey: IdempotencyKey,
    requested: bigint | null,
  ) {
    return yield* database.transaction(
      Effect.gen(function* () {
        // Shared, so a deactivation waits until this payment is saved.
        const found = yield* database.use((db) =>
          db.select().from(paymentLinks).where(eq(paymentLinks.shareToken, shareToken)).for("share"),
        )

        const row = found[0]

        if (row === undefined) {
          return yield* new LinkNotFoundError()
        }

        const amountMinor = yield* Effect.fromResult(amountFor(pricingOf(row), requested))

        const existing = (yield* byKey(row.id, idempotencyKey))[0]

        if (existing !== undefined) {
          return yield* repeated(existing, amountMinor)
        }

        if (row.deactivatedAt !== null) {
          return yield* new LinkInactiveError({ id: ID.make(row.id) })
        }

        // A concurrent start with the same key waits on the unique index, and
        // whichever commits first is the payment both return.
        const inserted = yield* database.use((db) =>
          db
            .insert(payments)
            .values({
              id: createId("pay"),
              businessId: row.businessId,
              linkId: row.id,
              idempotencyKey,
              amountMinor,
              currencyCode: row.currencyCode,
              scale: row.scale,
              expiresAt: sql`now() + make_interval(mins => ${paymentWindowMinutes})`,
            })
            .onConflictDoNothing({ target: [payments.linkId, payments.idempotencyKey] })
            .returning(),
        )

        if (inserted[0] !== undefined) {
          return { payment: paymentOf(inserted[0]), created: true }
        }

        const raced = (yield* byKey(row.id, idempotencyKey))[0]

        if (raced === undefined) {
          return yield* Effect.die(new Error(`payment for key vanished in ${row.id}`))
        }

        return yield* repeated(raced, amountMinor)
      }),
    )
  })

  // Each step is one statement that only moves a pending payment, so two
  // outcomes reported at once can't both land, and an expiry always commits.
  const simulate = Effect.fn("Payments.simulate")(function* (
    shareToken: string,
    paymentId: string,
    outcome: Outcome,
  ) {
    const { link } = yield* findLink(shareToken)

    const ended = yield* database.use((db) =>
      db
        .update(payments)
        .set({ status: outcome, completedAt: sql`now()` })
        .where(
          and(
            eq(payments.id, paymentId),
            eq(payments.linkId, link.id),
            eq(payments.status, "pending"),
            gt(payments.expiresAt, sql`now()`),
          ),
        )
        .returning(),
    )

    if (ended[0] !== undefined) {
      return paymentOf(ended[0])
    }

    const found = yield* database.use((db) =>
      db
        .select()
        .from(payments)
        .where(and(eq(payments.id, paymentId), eq(payments.linkId, link.id))),
    )

    const row = found[0]

    if (row === undefined) {
      return yield* new PaymentNotFoundError({ linkId: link.id, id: paymentId })
    }

    const expired = yield* expireIfDue(row.id)

    return yield* new PaymentClosedError({ payment: paymentOf(expired[0] ?? row) })
  })

  return Service.of({ createLink, findLink, startPayment, simulate })
})

export const layer = Layer.effect(Service)(make)

export * as Payments from "./payments.ts"
