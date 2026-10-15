import { and, eq } from "drizzle-orm"
import { Context, Effect, Encoding, Layer, Schema } from "effect"

import { Business } from "../business/business.ts"
import { businesses } from "../business/sql.ts"
import { Database } from "../database/client.ts"
import { createId } from "../database/ids.ts"
import { Currency } from "../ledger/currency.ts"
import { ledgers } from "../ledger/sql.ts"
import { maxAmount, paymentLinks } from "./sql.ts"

export { maxAmount } from "./sql.ts"

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
  createdAt: Schema.Date,
}) {}

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
    createdAt: row.createdAt,
  })

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

const shareToken = () => Encoding.encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)))

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

  return Service.of({ createLink })
})

export const layer = Layer.effect(Service)(make)

export * as Payments from "./payments.ts"
