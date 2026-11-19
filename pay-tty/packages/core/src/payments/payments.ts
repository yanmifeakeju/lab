import { and, desc, eq, gt, lte, type SQL, sql } from "drizzle-orm"
import { Context, Duration, Effect, Encoding, Layer, Result, Schema } from "effect"
import { Business } from "../business/business.ts"
import { businesses } from "../business/sql.ts"
import { Database } from "../database/client.ts"
import { IdempotencyKey, isOneLine } from "../common/schemas.ts"
import { fromNow, maxAmount } from "@pay-tty/database/columns"
import { createId } from "../database/ids.ts"
import { cursorAt, pages } from "@pay-tty/database/pages"
import { Currency } from "../ledger/currency.ts"
import { Ledger } from "../ledger/slug.ts"
import { ledgerPostings, ledgers, platformAccounts } from "../ledger/sql.ts"
import { paymentLinks, payments, paymentStatuses } from "./sql.ts"

/** TTL in minutes for a pending payment before it expires. */
export const paymentWindowMinutes = 30

/** Maximum payment links returned per business listing, ordered newest first. */
export const linkListLimit = 100

export const paymentPageSize = 50

export const ID = Schema.String.pipe(
  Schema.check(Schema.isStartsWith("plink_")),
  Schema.brand("Payments.ID"),
)

export type ID = typeof ID.Type

/** Positive amount in minor units of the link's ledger. */
export const Amount = Schema.BigInt.check(
  Schema.isGreaterThanBigInt(0n),
  Schema.isLessThanOrEqualToBigInt(maxAmount),
)

export const Title = Schema.NonEmptyString.check(Schema.isTrimmed(), Schema.isMaxLength(255), isOneLine)

export const Description = Schema.NonEmptyString.check(Schema.isTrimmed(), Schema.isMaxLength(500))

/** Minimum allowed amount for a currency (`10^scale`, i.e., one major unit). */
export const minimumAmount = (scale: number) => 10n ** BigInt(scale)

export class Fixed extends Schema.Class<Fixed>("Payments.Fixed")({
  mode: Schema.tag("fixed"),
  amount: Amount,
}) {}

export interface Bounds {
  readonly suggestedAmount: bigint | null
  readonly minimumAmount: bigint | null
  readonly maximumAmount: bigint | null
}

/** Validates customer-chosen pricing bounds; returns the violated field and message, or undefined. */
export const boundsViolation = (
  bounds: Bounds,
): { readonly setting: "suggested" | "maximum"; readonly message: string } | undefined => {
  const { suggestedAmount: suggested, minimumAmount: minimum, maximumAmount: maximum } = bounds

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

export class CustomerChooses extends Schema.Class<CustomerChooses>("Payments.CustomerChooses")(
  Schema.Struct({
    mode: Schema.tag("customer_chooses"),
    suggestedAmount: Schema.NullOr(Amount),
    minimumAmount: Schema.NullOr(Amount),
    maximumAmount: Schema.NullOr(Amount),
  }).check(
    Schema.makeFilter((bounds) => {
      const violation = boundsViolation(bounds)

      return violation === undefined
        ? undefined
        : { path: [`${violation.setting}Amount`], issue: violation.message }
    }),
  ),
) {}

export const Pricing = Schema.Union([Fixed, CustomerChooses])

export type Pricing = typeof Pricing.Type

/** Input payload for creating a payment link; compared field-by-field on idempotent retries. */
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
  ledger: Ledger.Slug,
  currencyCode: Currency.Code,
  scale: Schema.Int,
  pricing: Pricing,
  /** Unguessable token used to address the link publicly. */
  shareToken: Schema.String,
  /** Null while the link accepts new payments. */
  deactivatedAt: Schema.NullOr(Schema.Date),
  createdAt: Schema.Date,
}) {}

/** Public view of a payment link paired with the merchant's business name. */
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

/** Terminal outcomes reported by payment simulation (`expired` is clock-driven). */
export const Outcome = Schema.Literals(["succeeded", "failed", "cancelled"])

export type Outcome = typeof Outcome.Type

/**
 * Merchant-facing payment state, derived at query time from `payments.status`,
 * `expires_at`, and `ledger_postings.state`.
 */
export const State = Schema.Literals(["pending", "expired", "failed", "cancelled", "settling", "settled", "attention"])

export type State = typeof State.Type

export class Payment extends Schema.Class<Payment>("Payments.Payment")({
  id: PaymentID,
  linkId: ID,
  businessId: Business.ID,
  amount: Schema.BigInt,
  ledger: Ledger.Slug,
  currencyCode: Currency.Code,
  scale: Schema.Int,
  status: Status,
  createdAt: Schema.Date,
  expiresAt: Schema.Date,
  /** Timestamp when `status` left `pending`, or null while pending. */
  completedAt: Schema.NullOr(Schema.Date),
}) {}

export const Cursor = Schema.String.pipe(Schema.brand("Payments.Cursor"))

export type Cursor = typeof Cursor.Type

export const Source = Schema.Union([
  Schema.Struct({ kind: Schema.tag("link"), id: ID, title: Schema.String }),
])

export class PaymentSummary extends Schema.Class<PaymentSummary>("Payments.PaymentSummary")({
  ...Payment.fields,
  state: State,
  /** Timestamp when the ledger posted the entry, or null until settled. */
  settledAt: Schema.NullOr(Schema.Date),
  /** Ledger journal entry reference, once recorded. */
  journalRef: Schema.NullOr(Schema.String),
  source: Source,
}) {}

export class Paid extends Schema.TaggedClass<Paid>("Payments.Paid")("paid", { at: Schema.Date }) {}

/** Event recorded when the ledger posts the payment to the merchant's account. */
export class Settled extends Schema.TaggedClass<Settled>("Payments.Settled")("settled", {
  at: Schema.Date,
  journalRef: Schema.String,
}) {}

/** Event recorded when the ledger permanently rejects the payment's posting. */
export class Refused extends Schema.TaggedClass<Refused>("Payments.Refused")("refused", {
  at: Schema.Date,
  errorCode: Schema.String,
}) {}

/** Chronological timeline event for a payment. */
export const Event = Schema.Union([Paid, Settled, Refused])

export type Event = typeof Event.Type

export class PaymentDetail extends Schema.Class<PaymentDetail>("Payments.PaymentDetail")({
  payment: PaymentSummary,
  timeline: Schema.Array(Event),
}) {}

export class CursorError extends Schema.TaggedError<CursorError>()("Payments.CursorError", {}) {}

const cursors = pages(PaymentID)

export interface Filter {
  readonly linkId: ID | null
  readonly state: State | null
}

/**
 * Aggregated payment counts and totals for a link or business. Pending
 * payments past `expires_at` are counted as `expired`.
 */
export class Stats extends Schema.Class<Stats>("Payments.Stats")({
  succeeded: Schema.Int,
  failed: Schema.Int,
  cancelled: Schema.Int,
  expired: Schema.Int,
  pending: Schema.Int,
  /** Breakdown of `succeeded` payments by ledger posting state (`settling + settled + attention = succeeded`). */
  settling: Schema.Int,
  settled: Schema.Int,
  attention: Schema.Int,
  /** Sum of `settled` payment amounts in minor units. */
  collected: Schema.BigInt,
  /** Sum of `settling` payment amounts in minor units. */
  settlingAmount: Schema.BigInt,
  /** Completion timestamp of the most recent `succeeded` payment. */
  lastPaidAt: Schema.NullOr(Schema.Date),
}) {}

export class PaymentPage extends Schema.Class<PaymentPage>("Payments.PaymentPage")({
  payments: Schema.Array(PaymentSummary),
  stats: Stats,
  next: Schema.NullOr(Cursor),
}) {}

export class Summary extends Schema.Class<Summary>("Payments.Summary")({
  link: Link,
  stats: Stats,
}) {}

export class Overview extends Schema.Class<Overview>("Payments.Overview")({
  /** Up to `linkListLimit` links, ordered newest first. */
  links: Schema.Array(Summary),
  /** Total counts and payment stats across all links of the business. */
  linkCount: Schema.Int,
  activeLinkCount: Schema.Int,
  totals: Stats,
}) {}

export interface Started {
  readonly payment: Payment
  /** False when returned from an idempotent retry. */
  readonly created: boolean
}

export interface Created {
  readonly link: Link
  /** False when returned from an idempotent retry. */
  readonly created: boolean
}

/** Idempotency key was already used for this business with different link details. */
export class ConflictError extends Schema.TaggedError<ConflictError>()(
  "Payments.ConflictError",
  { businessId: Business.ID, existing: ID },
) {}

/** The business's payable account is not yet open. */
export class InactiveBusinessError extends Schema.TaggedError<InactiveBusinessError>()(
  "Payments.InactiveBusinessError",
  { businessId: Business.ID },
) {}

/** No payment link matches the given share token or ID. */
export class LinkNotFoundError extends Schema.TaggedError<LinkNotFoundError>()("Payments.LinkNotFoundError", {}) {}

/** The payment link has been deactivated and no longer accepts new payments. */
export class LinkInactiveError extends Schema.TaggedError<LinkInactiveError>()(
  "Payments.LinkInactiveError",
  { id: ID },
) {}

/** Requested payment amount violates the link's pricing rules. */
export class AmountError extends Schema.TaggedError<AmountError>()("Payments.AmountError", {
  reason: Schema.Literals(["required", "unexpected", "below_currency_minimum", "below_minimum", "above_maximum"]),
  message: Schema.String,
}) {}

/** A pricing field is below one whole unit (`10^scale`) of the ledger's currency. */
export class DetailsError extends Schema.TaggedError<DetailsError>()("Payments.DetailsError", {
  field: Schema.Literals(["amount", "suggestedAmount", "minimumAmount", "maximumAmount"]),
  message: Schema.String,
}) {}

/** Idempotency key was already used on this link for a different amount. */
export class PaymentConflictError extends Schema.TaggedError<PaymentConflictError>()(
  "Payments.PaymentConflictError",
  { linkId: ID, existing: PaymentID },
) {}

/** No payment with `id` exists for the specified link or business. */
export class PaymentNotFoundError extends Schema.TaggedError<PaymentNotFoundError>()(
  "Payments.PaymentNotFoundError",
  { linkId: Schema.NullOr(ID), id: Schema.String },
) {}

/** Payment is no longer `pending` and cannot be simulated. */
export class PaymentClosedError extends Schema.TaggedError<PaymentClosedError>()(
  "Payments.PaymentClosedError",
  { payment: Payment },
) {}

export interface Interface {
  /**
   * Creates a payment link in the business's primary ledger. Idempotent per
   * `(businessId, idempotencyKey)` when `details` match; returns `ConflictError`
   * if `details` differ.
   */
  readonly createLink: (
    businessId: Business.ID,
    idempotencyKey: IdempotencyKey,
    details: Details,
  ) => Effect.Effect<Created, Business.NotFoundError | InactiveBusinessError | DetailsError | ConflictError>
  /** Looks up a payment link by `shareToken` (whether active or deactivated). */
  readonly findLink: (shareToken: string) => Effect.Effect<Payable, LinkNotFoundError>
  /**
   * Starts a pending payment expiring after `paymentWindowMinutes`. Idempotent
   * per `(link, idempotencyKey)` when `amount` matches, even if the link was
   * subsequently deactivated. `amount` must be null for fixed-price links.
   */
  readonly startPayment: (
    shareToken: string,
    idempotencyKey: IdempotencyKey,
    amount: bigint | null,
  ) => Effect.Effect<
    Started,
    LinkNotFoundError | LinkInactiveError | AmountError | PaymentConflictError
  >
  /**
   * Resolves a pending payment with `outcome`. If the payment has passed
   * `expires_at`, marks it `expired` and fails with `PaymentClosedError`. On
   * `succeeded`, inserts a `ledger_postings` row in the same transaction.
   */
  readonly simulate: (
    shareToken: string,
    paymentId: string,
    outcome: Outcome,
  ) => Effect.Effect<Payment, LinkNotFoundError | PaymentNotFoundError | PaymentClosedError>
  /** Lists the business's links with per-link and overall stats. */
  readonly listLinks: (businessId: Business.ID) => Effect.Effect<Overview>
  /** Lists a page of the business's payments, newest first, with filtered stats. */
  readonly listPayments: (
    businessId: Business.ID,
    filter: Filter & { readonly before: Cursor | null },
  ) => Effect.Effect<PaymentPage, LinkNotFoundError | CursorError>
  /** Retrieves a single payment and its event timeline. */
  readonly getPayment: (businessId: Business.ID, id: string) => Effect.Effect<PaymentDetail, PaymentNotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("Payments") {}

type Row = typeof paymentLinks.$inferSelect

const inLedger = { currency: ledgers.currency, scale: ledgers.scale }

const linkColumns = { link: paymentLinks, ...inLedger }

interface LinkRow {
  readonly link: Row
  readonly currency: string
  readonly scale: number
}

const pricingOf = (row: Row): Pricing => {
  if (row.pricingMode === "fixed") {
    if (row.amount === null) {
      throw new Error(`fixed payment link ${row.id} has no amount`)
    }

    return new Fixed({ amount: row.amount })
  }

  return new CustomerChooses({
    suggestedAmount: row.suggestedAmount,
    minimumAmount: row.minimumAmount,
    maximumAmount: row.maximumAmount,
  })
}

const fromRow = ({ link, currency, scale }: LinkRow) =>
  new Link({
    id: ID.make(link.id),
    businessId: Business.ID.make(link.businessId),
    title: link.title,
    description: link.description,
    ledger: Ledger.Slug.make(link.ledger),
    currencyCode: Currency.Code.make(currency),
    scale,
    pricing: pricingOf(link),
    shareToken: link.shareToken,
    deactivatedAt: link.deactivatedAt,
    createdAt: link.createdAt,
  })

const paymentColumns = { payment: payments, ...inLedger }

interface PaymentRow {
  readonly payment: typeof payments.$inferSelect
  readonly currency: string
  readonly scale: number
}

const paymentFields = ({ payment, currency, scale }: PaymentRow) => ({
  id: PaymentID.make(payment.id),
  linkId: ID.make(payment.linkId),
  businessId: Business.ID.make(payment.businessId),
  amount: payment.amount,
  ledger: Ledger.Slug.make(payment.ledger),
  currencyCode: Currency.Code.make(currency),
  scale,
  status: payment.status,
  createdAt: payment.createdAt,
  expiresAt: payment.expiresAt,
  completedAt: payment.completedAt,
})

const paymentOf = (row: PaymentRow) => new Payment(paymentFields(row))

const counted = (condition: SQL) => sql`count(*) filter (where ${condition})`.mapWith(Number)

const isStatus = (status: Status) => sql`${payments.status} = ${status}`

const due = sql`${payments.expiresAt} <= now()`

const statusCondition = (status: Status): SQL => {
  if (status === "expired") {
    return sql`(${isStatus("expired")} or (${isStatus("pending")} and ${due}))`
  }

  if (status === "pending") {
    return sql`${isStatus("pending")} and not ${due}`
  }

  return isStatus(status)
}

const effectiveStatus = sql<Status>`case when ${isStatus("pending")} and ${due} then 'expired' else ${payments.status} end`

// Derives merchant-facing state across `payments` left-joined to `ledger_postings`.
// Succeeded payments with a missing or `refused` posting surface as `attention`.
const state = sql<State>`case
  when ${isStatus("succeeded")} then case
    when ${ledgerPostings.state} in ('created', 'pending') then 'settling'
    when ${ledgerPostings.state} = 'posted' then 'settled'
    else 'attention'
  end
  else (${effectiveStatus})::text
end`

const inState = (value: State) => sql`(${state}) = ${value}`

// Cast to text so sums exceeding `MAX_SAFE_INTEGER` decode into `bigint` without precision loss.
const summed = (condition: SQL) => sql<string>`coalesce(sum(${payments.amount}) filter (where ${condition}), 0)::text`

const statsColumns = {
  succeeded: counted(isStatus("succeeded")),
  failed: counted(isStatus("failed")),
  cancelled: counted(isStatus("cancelled")),
  expired: counted(statusCondition("expired")),
  pending: counted(statusCondition("pending")),
  settling: counted(inState("settling")),
  settled: counted(inState("settled")),
  attention: counted(inState("attention")),
  collected: summed(inState("settled")),
  settlingAmount: summed(inState("settling")),
  lastPaidAt: sql`max(${payments.completedAt}) filter (where ${isStatus("succeeded")})`.mapWith(payments.completedAt),
}

const postingOf = eq(ledgerPostings.paymentId, payments.id)

type StatsRow = {
  readonly [K in keyof typeof statsColumns]: (typeof statsColumns)[K]["_"]["type"]
}

const statsOf = (row: StatsRow) =>
  new Stats({ ...row, collected: BigInt(row.collected), settlingAmount: BigInt(row.settlingAmount) })

const summaryColumns = {
  ...paymentColumns,
  status: effectiveStatus,
  state,
  title: paymentLinks.title,
  postingState: ledgerPostings.state,
  journalRef: ledgerPostings.journalRef,
  recordedAt: ledgerPostings.recordedAt,
}

interface SummaryRow extends PaymentRow {
  readonly status: Status
  readonly state: State
  readonly title: string
  readonly postingState: string | null
  readonly journalRef: string | null
  readonly recordedAt: Date | null
}

const summaryOf = ({ status, state, title, postingState, journalRef, recordedAt, ...row }: SummaryRow) =>
  new PaymentSummary({
    ...paymentFields(row),
    status,
    state,
    settledAt: postingState === "posted" ? recordedAt : null,
    journalRef,
    source: { kind: "link", id: ID.make(row.payment.linkId), title },
  })

// Read-only `REPEATABLE READ` snapshot so paginated rows and aggregate totals
// observe the same committed state and `now()` timestamp.
const snapshot = { isolationLevel: "repeatable read", accessMode: "read only" } as const

/** Currency code and minor-unit scale. */
export interface Unit {
  readonly currencyCode: string
  readonly scale: number
}

const leastText = (unit: Unit) =>
  `must be at least ${Currency.format(minimumAmount(unit.scale), unit.scale, unit.currencyCode)}`

/**
 * Resolves and validates the payment amount for `pricing` and `requested`.
 */
export const amountFor = (
  pricing: Pricing,
  unit: Unit,
  requested: bigint | null,
): Result.Result<bigint, AmountError> => {
  if (pricing.mode === "fixed") {
    return requested === null
      ? Result.succeed(pricing.amount)
      : Result.fail(new AmountError({ reason: "unexpected", message: "a fixed-price link charges its own amount" }))
  }

  if (requested === null) {
    return Result.fail(new AmountError({ reason: "required", message: "this link needs the amount to pay" }))
  }

  if (requested < minimumAmount(unit.scale)) {
    return Result.fail(new AmountError({ reason: "below_currency_minimum", message: `the amount ${leastText(unit)}` }))
  }

  if (pricing.minimumAmount !== null && requested < pricing.minimumAmount) {
    return Result.fail(new AmountError({ reason: "below_minimum", message: "the amount must be at least the minimum" }))
  }

  if (pricing.maximumAmount !== null && requested > pricing.maximumAmount) {
    return Result.fail(new AmountError({ reason: "above_maximum", message: "the amount must be at most the maximum" }))
  }

  return Result.succeed(requested)
}

// Returns a `DetailsError` for the first pricing field below `minimumAmount(unit.scale)`, if any.
const belowUnit = (pricing: Pricing, unit: Unit): DetailsError | undefined => {
  const settings = pricing.mode === "fixed"
    ? [["amount", pricing.amount] as const]
    : ([
        ["suggestedAmount", pricing.suggestedAmount],
        ["minimumAmount", pricing.minimumAmount],
        ["maximumAmount", pricing.maximumAmount],
      ] as const)

  for (const [field, amount] of settings) {
    if (amount !== null && amount < minimumAmount(unit.scale)) {
      return new DetailsError({ field, message: leastText(unit) })
    }
  }

  return undefined
}

const columnsOf = (pricing: Pricing) =>
  pricing.mode === "fixed"
    ? {
        pricingMode: pricing.mode,
        amount: pricing.amount,
        suggestedAmount: null,
        minimumAmount: null,
        maximumAmount: null,
      }
    : {
        pricingMode: pricing.mode,
        amount: null,
        suggestedAmount: pricing.suggestedAmount,
        minimumAmount: pricing.minimumAmount,
        maximumAmount: pricing.maximumAmount,
      }

// Compares caller-supplied link fields for idempotency checks.
const sameDetails = (row: Row, details: Details) => {
  const pricing = columnsOf(details.pricing)

  return (
    row.title === details.title &&
    row.description === details.description &&
    row.pricingMode === pricing.pricingMode &&
    row.amount === pricing.amount &&
    row.suggestedAmount === pricing.suggestedAmount &&
    row.minimumAmount === pricing.minimumAmount &&
    row.maximumAmount === pricing.maximumAmount
  )
}

// Generates a 43-char base64url token that never begins with `-` (OpenSSH
// rejects usernames starting with `-`).
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
        .select({ ledger: ledgers.slug, status: businesses.status, ...inLedger })
        .from(businesses)
        .innerJoin(ledgers, eq(ledgers.slug, businesses.primaryLedger))
        .where(eq(businesses.id, businessId)),
    )

    const owner = owners[0]

    if (owner === undefined) {
      return yield* new Business.NotFoundError({ id: businessId })
    }

    if (owner.status !== "active") {
      return yield* new InactiveBusinessError({ businessId })
    }

    const unit = { currencyCode: owner.currency, scale: owner.scale }
    const below = belowUnit(details.pricing, unit)

    if (below !== undefined) {
      return yield* below
    }

    // `ON CONFLICT DO NOTHING` on `(business_id, idempotency_key)` serializes concurrent creates.
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
          ledger: owner.ledger,
          ...columnsOf(details.pricing),
        })
        .onConflictDoNothing({ target: [paymentLinks.businessId, paymentLinks.idempotencyKey] })
        .returning(),
    )

    if (inserted[0] !== undefined) {
      return { link: fromRow({ link: inserted[0], currency: owner.currency, scale: owner.scale }), created: true }
    }

    const existing = yield* database.use((db) =>
      db
        .select(linkColumns)
        .from(paymentLinks)
        .innerJoin(ledgers, eq(ledgers.slug, paymentLinks.ledger))
        .where(and(eq(paymentLinks.businessId, businessId), eq(paymentLinks.idempotencyKey, idempotencyKey))),
    )

    const row = existing[0]

    if (row === undefined) {
      return yield* Effect.die(new Error(`payment link for key vanished in ${businessId}`))
    }

    if (!sameDetails(row.link, details)) {
      return yield* new ConflictError({ businessId, existing: ID.make(row.link.id) })
    }

    return { link: fromRow(row), created: false }
  })

  const findLink = Effect.fn("Payments.findLink")(function* (shareToken: string) {
    const found = yield* database.use((db) =>
      db
        .select({ ...linkColumns, businessName: businesses.name })
        .from(paymentLinks)
        .innerJoin(ledgers, eq(ledgers.slug, paymentLinks.ledger))
        .innerJoin(businesses, eq(businesses.id, paymentLinks.businessId))
        .where(eq(paymentLinks.shareToken, shareToken)),
    )

    const row = found[0]

    if (row === undefined) {
      return yield* new LinkNotFoundError()
    }

    return new Payable({ link: fromRow(row), businessName: row.businessName })
  })

  // Transitions a pending payment past `expires_at` to `expired` with `completed_at = expires_at`.
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
        .select(paymentColumns)
        .from(payments)
        .innerJoin(ledgers, eq(ledgers.slug, payments.ledger))
        .where(and(eq(payments.linkId, linkId), eq(payments.idempotencyKey, idempotencyKey))),
    )

  const repeated = Effect.fnUntraced(function* (row: PaymentRow, amount: bigint) {
    if (row.payment.amount !== amount) {
      return yield* new PaymentConflictError({
        linkId: ID.make(row.payment.linkId),
        existing: PaymentID.make(row.payment.id),
      })
    }

    const expired = yield* expireIfDue(row.payment.id)

    return { payment: paymentOf({ ...row, payment: expired[0] ?? row.payment }), created: false }
  })

  const startPayment = Effect.fn("Payments.startPayment")(function* (
    shareToken: string,
    idempotencyKey: IdempotencyKey,
    requested: bigint | null,
  ) {
    return yield* database.transaction(
      Effect.gen(function* () {
        // Take a `FOR SHARE` lock on the link so concurrent deactivation waits until this payment commits.
        const found = yield* database.use((db) =>
          db
            .select(linkColumns)
            .from(paymentLinks)
            .innerJoin(ledgers, eq(ledgers.slug, paymentLinks.ledger))
            .where(eq(paymentLinks.shareToken, shareToken))
            .for("share", { of: paymentLinks }),
        )

        const joined = found[0]

        if (joined === undefined) {
          return yield* new LinkNotFoundError()
        }

        const { link: row, ...ledger } = joined

        const amount = yield* Effect.fromResult(
          amountFor(pricingOf(row), { currencyCode: ledger.currency, scale: ledger.scale }, requested),
        )

        const existing = (yield* byKey(row.id, idempotencyKey))[0]

        if (existing !== undefined) {
          return yield* repeated(existing, amount)
        }

        if (row.deactivatedAt !== null) {
          return yield* new LinkInactiveError({ id: ID.make(row.id) })
        }

        const inserted = yield* database.use((db) =>
          db
            .insert(payments)
            .values({
              id: createId("pay"),
              businessId: row.businessId,
              linkId: row.id,
              idempotencyKey,
              amount,
              ledger: row.ledger,
              expiresAt: fromNow(Duration.minutes(paymentWindowMinutes)),
            })
            .onConflictDoNothing({ target: [payments.linkId, payments.idempotencyKey] })
            .returning(),
        )

        if (inserted[0] !== undefined) {
          return { payment: paymentOf({ payment: inserted[0], ...ledger }), created: true }
        }

        const raced = (yield* byKey(row.id, idempotencyKey))[0]

        if (raced === undefined) {
          return yield* Effect.die(new Error(`payment for key vanished in ${row.id}`))
        }

        return yield* repeated(raced, amount)
      }),
    )
  })

  // Enqueues a `ledger_postings` entry debiting `receivable` and crediting the business's payable account.
  const post = Effect.fnUntraced(function* (payment: typeof payments.$inferSelect) {
    const found = yield* database.use((db) =>
      db
        .select({
          receivable: platformAccounts.ledgerAccountRef,
          payable: businesses.primaryPayableAccountRef,
          title: paymentLinks.title,
        })
        .from(businesses)
        .leftJoin(
          platformAccounts,
          and(eq(platformAccounts.ledger, payment.ledger), eq(platformAccounts.label, "receivable")),
        )
        .leftJoin(paymentLinks, eq(paymentLinks.id, payment.linkId))
        .where(eq(businesses.id, payment.businessId)),
    )

    const receivable = found[0]?.receivable ?? null
    const payable = found[0]?.payable ?? null
    const title = found[0]?.title ?? null

    if (receivable === null || payable === null || title === null) {
      return yield* Effect.die(
        new Error(`no receivable or payable account, or no link, for payment ${payment.id} in ${payment.ledger}`),
      )
    }

    yield* database.use((db) =>
      db.insert(ledgerPostings).values({
        id: createId("lpost"),
        businessId: payment.businessId,
        ledger: payment.ledger,
        paymentId: payment.id,
        kind: "payment",
        description: `Payment received via ${title}`,
        lines: [
          {
            debit_account_ref: receivable,
            credit_account_ref: payable,
            amount: payment.amount.toString(),
            purpose: "payment",
          },
        ],
      }),
    )
  })

  // Atomically transitions a non-expired `pending` payment to `outcome` and
  // enqueues its ledger posting on `succeeded`.
  const simulate = Effect.fn("Payments.simulate")(function* (
    shareToken: string,
    paymentId: string,
    outcome: Outcome,
  ) {
    const { link } = yield* findLink(shareToken)

    const ended = yield* database.transaction(
      Effect.gen(function* () {
        const updated = yield* database.use((db) =>
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

        const payment = updated[0]

        if (payment?.status === "succeeded") {
          yield* post(payment)
        }

        return payment
      }),
    )

    const ledger = { currency: link.currencyCode, scale: link.scale }

    if (ended !== undefined) {
      return paymentOf({ payment: ended, ...ledger })
    }

    const found = yield* database.use((db) =>
      db
        .select(paymentColumns)
        .from(payments)
        .innerJoin(ledgers, eq(ledgers.slug, payments.ledger))
        .where(and(eq(payments.id, paymentId), eq(payments.linkId, link.id))),
    )

    const row = found[0]

    if (row === undefined) {
      return yield* new PaymentNotFoundError({ linkId: link.id, id: paymentId })
    }

    const expired = yield* expireIfDue(row.payment.id)

    return yield* new PaymentClosedError({ payment: paymentOf({ ...row, payment: expired[0] ?? row.payment }) })
  })

  const listLinks = Effect.fn("Payments.listLinks")(function* (businessId: Business.ID) {
    const { listed, totals } = yield* database.transaction(
      Effect.gen(function* () {
        const listed = yield* database.use((db) =>
          db
            .select({ ...linkColumns, ...statsColumns })
            .from(paymentLinks)
            .innerJoin(ledgers, eq(ledgers.slug, paymentLinks.ledger))
            .leftJoin(payments, eq(payments.linkId, paymentLinks.id))
            .leftJoin(ledgerPostings, postingOf)
            .where(eq(paymentLinks.businessId, businessId))
            .groupBy(paymentLinks.id, ledgers.slug)
            .orderBy(desc(paymentLinks.createdAt), desc(paymentLinks.id))
            .limit(linkListLimit),
        )

        const totals = yield* database.use((db) =>
          db
            .select({
              linkCount: sql`count(distinct ${paymentLinks.id})`.mapWith(Number),
              activeLinkCount: sql`count(distinct ${paymentLinks.id}) filter (where ${paymentLinks.deactivatedAt} is null)`.mapWith(Number),
              ...statsColumns,
            })
            .from(paymentLinks)
            .leftJoin(payments, eq(payments.linkId, paymentLinks.id))
            .leftJoin(ledgerPostings, postingOf)
            .where(eq(paymentLinks.businessId, businessId)),
        )

        return { listed, totals }
      }),
      snapshot,
    )

    const row = totals[0]

    if (row === undefined) {
      return yield* Effect.die(new Error(`no link totals for ${businessId}`))
    }

    const { linkCount, activeLinkCount, ...total } = row

    return new Overview({
      links: listed.map(({ link, currency, scale, ...stats }) =>
        new Summary({ link: fromRow({ link, currency, scale }), stats: statsOf(stats) }),
      ),
      linkCount,
      activeLinkCount,
      totals: statsOf(total),
    })
  })

  const listPayments = Effect.fn("Payments.listPayments")(function* (
    businessId: Business.ID,
    filter: Filter & { readonly before: Cursor | null },
  ) {
    const { linkId, before } = filter

    if (linkId !== null) {
      const links = yield* database.use((db) =>
        db
          .select({ id: paymentLinks.id })
          .from(paymentLinks)
          .where(and(eq(paymentLinks.id, linkId), eq(paymentLinks.businessId, businessId))),
      )

      if (links.length === 0) {
        return yield* new LinkNotFoundError()
      }
    }

    const position = before === null ? null : yield* cursors.decode(before).pipe(Effect.mapError(() => new CursorError()))

    const where = and(
      eq(payments.businessId, businessId),
      linkId === null ? undefined : eq(payments.linkId, linkId),
      filter.state === null ? undefined : inState(filter.state),
    )

    return yield* database.transaction(
      Effect.gen(function* () {
        const listed = yield* database.use((db) =>
          db
            .select({
              ...summaryColumns,
              at: cursorAt(payments.createdAt),
            })
            .from(payments)
            .innerJoin(ledgers, eq(ledgers.slug, payments.ledger))
            .innerJoin(paymentLinks, eq(paymentLinks.id, payments.linkId))
            .leftJoin(ledgerPostings, postingOf)
            .where(and(where, cursors.before(payments.createdAt, payments.id, position)))
            .orderBy(desc(payments.createdAt), desc(payments.id))
            .limit(paymentPageSize + 1),
        )

        const totals = yield* database.use((db) =>
          db.select(statsColumns).from(payments).leftJoin(ledgerPostings, postingOf).where(where),
        )

        const total = totals[0]

        if (total === undefined) {
          return yield* Effect.die(new Error("payment totals missing"))
        }

        const { rows, next } = yield* cursors.page(listed, paymentPageSize, (last) => ({
          at: last.at,
          id: PaymentID.make(last.payment.id),
        }))

        return new PaymentPage({
          payments: rows.map(summaryOf),
          stats: statsOf(total),
          next: next === null ? null : Cursor.make(next),
        })
      }),
      snapshot,
    )
  })

  const getPayment = Effect.fn("Payments.getPayment")(function* (businessId: Business.ID, id: string) {
    const found = yield* database.use((db) =>
      db
        .select({
          ...summaryColumns,
          errorCode: ledgerPostings.errorCode,
          lastAttemptAt: ledgerPostings.lastAttemptAt,
        })
        .from(payments)
        .innerJoin(ledgers, eq(ledgers.slug, payments.ledger))
        .innerJoin(paymentLinks, eq(paymentLinks.id, payments.linkId))
        .leftJoin(ledgerPostings, postingOf)
        .where(and(eq(payments.id, id), eq(payments.businessId, businessId))),
    )

    const row = found[0]

    if (row === undefined) {
      return yield* new PaymentNotFoundError({ linkId: null, id })
    }

    const { errorCode, lastAttemptAt, ...summary } = row
    const { payment, postingState, journalRef, recordedAt } = summary
    const timeline: Array<Event> = []

    if (payment.status === "succeeded" && payment.completedAt !== null) {
      timeline.push(new Paid({ at: payment.completedAt }))
    }

    if (postingState === "posted" && recordedAt !== null && journalRef !== null) {
      timeline.push(new Settled({ at: recordedAt, journalRef }))
    }

    if (postingState === "refused" && lastAttemptAt !== null && errorCode !== null) {
      timeline.push(new Refused({ at: lastAttemptAt, errorCode }))
    }

    return new PaymentDetail({ payment: summaryOf(summary), timeline })
  })

  return Service.of({ createLink, findLink, startPayment, simulate, listLinks, listPayments, getPayment })
})

export const layer = Layer.effect(Service)(make)

export * as Payments from "./payments.ts"
