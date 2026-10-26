import { and, desc, eq, gt, lte, type SQL, sql } from "drizzle-orm"
import { Context, DateTime, Effect, Encoding, Layer, Option, Result, Schema } from "effect"

import { Business } from "../business/business.ts"
import { businesses } from "../business/sql.ts"
import { Database } from "../database/client.ts"
import { createId } from "../database/ids.ts"
import { Currency } from "../ledger/currency.ts"
import { Ledger } from "../ledger/slug.ts"
import { ledgerPostings, ledgers, platformAccounts } from "../ledger/sql.ts"
import { maxAmount, paymentLinks, payments, paymentStatuses } from "./sql.ts"

export { maxAmount } from "./sql.ts"

/** How long a payment stays pending before it expires. */
export const paymentWindowMinutes = 30

/** How many of a business's links a listing returns, newest first. */
export const linkListLimit = 100

export const paymentPageSize = 50

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

/** One whole unit of the currency: the least a link or payment takes. */
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

/** The setting that breaks the bounds and why, or undefined when they hold. */
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

// Every setting may be unset: the payer then chooses any amount.
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
  ledger: Ledger.Slug,
  /** The ledger's, as are the payments'. */
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

/**
 * Where a payment stands for its merchant: its effective status until it
 * succeeds, then how its posting to the ledger is going. Worked out when read,
 * never stored.
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
  /** When it left pending; null while pending. */
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
  /** When the ledger posted the payment; null until it is settled. */
  settledAt: Schema.NullOr(Schema.Date),
  /** The ledger's journal entry for it, once there is one. */
  journalRef: Schema.NullOr(Schema.String),
  source: Source,
}) {}

export class Paid extends Schema.TaggedClass<Paid>("Payments.Paid")("paid", { at: Schema.Date }) {}

/** The ledger posted the payment to the merchant's account. */
export class Settled extends Schema.TaggedClass<Settled>("Payments.Settled")("settled", {
  at: Schema.Date,
  journalRef: Schema.String,
}) {}

/** The ledger won't take the payment's posting, as of its last attempt. */
export class Refused extends Schema.TaggedClass<Refused>("Payments.Refused")("refused", {
  at: Schema.Date,
  errorCode: Schema.String,
}) {}

/** What happened to a payment, oldest first. */
export const Event = Schema.Union([Paid, Settled, Refused])

export type Event = typeof Event.Type

export class PaymentDetail extends Schema.Class<PaymentDetail>("Payments.PaymentDetail")({
  payment: PaymentSummary,
  timeline: Schema.Array(Event),
}) {}

export class CursorError extends Schema.TaggedError<CursorError>()("Payments.CursorError", {}) {}

// Postgres emits the timestamp, including microseconds. Validate before using it
// in a timestamp cast so malformed cursors are request errors, not SQL defects.
const cursorValue = Schema.fromJsonString(Schema.Struct({
  at: Schema.String.check(
    Schema.isPattern(/^(?!0000)\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?[+-](?:0\d|1[0-5])(?::[0-5]\d)?$/),
    Schema.makeFilter((at) => {
      const date = DateTime.make(at)
      const day = DateTime.make(at.slice(0, 10) + "T00:00:00Z")

      return Option.isSome(date) && Option.isSome(day) &&
        DateTime.formatIsoDate(day.value) === at.slice(0, 10)
    }),
  ),
  id: PaymentID,
}))

export interface Filter {
  readonly linkId: ID | null
  readonly state: State | null
}

/**
 * What a link's payments, or a business's, came to. A pending payment past its
 * window counts as expired, whether or not anything has marked it yet.
 */
export class Stats extends Schema.Class<Stats>("Payments.Stats")({
  succeeded: Schema.Int,
  failed: Schema.Int,
  cancelled: Schema.Int,
  expired: Schema.Int,
  pending: Schema.Int,
  /** Succeeded payments by how their posting stands; together, `succeeded`. */
  settling: Schema.Int,
  settled: Schema.Int,
  attention: Schema.Int,
  /** The sum of settled payments, in minor units at the link's scale. */
  collected: Schema.BigInt,
  /** The sum of payments still settling. */
  settlingAmount: Schema.BigInt,
  /** When the latest succeeded payment completed. */
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
  /** The newest `linkListLimit` links. */
  links: Schema.Array(Summary),
  /** Counts and totals over every link, listed or not. */
  linkCount: Schema.Int,
  activeLinkCount: Schema.Int,
  totals: Stats,
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

/** The business's account isn't open yet, so it can't take payments. */
export class InactiveBusinessError extends Schema.TaggedError<InactiveBusinessError>()(
  "Payments.InactiveBusinessError",
  { businessId: Business.ID },
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
  reason: Schema.Literals(["required", "unexpected", "below_currency_minimum", "below_minimum", "above_maximum"]),
  message: Schema.String,
}) {}

/** A pricing setting is below one whole unit of the ledger's currency. */
export class DetailsError extends Schema.TaggedError<DetailsError>()("Payments.DetailsError", {
  field: Schema.Literals(["amount", "suggestedAmount", "minimumAmount", "maximumAmount"]),
  message: Schema.String,
}) {}

/** The key already started a payment for another amount; that payment is unchanged. */
export class PaymentConflictError extends Schema.TaggedError<PaymentConflictError>()(
  "Payments.PaymentConflictError",
  { linkId: ID, existing: PaymentID },
) {}

/** The link, or the business when the link is null, has no payment with this ID. */
export class PaymentNotFoundError extends Schema.TaggedError<PaymentNotFoundError>()(
  "Payments.PaymentNotFoundError",
  { linkId: Schema.NullOr(ID), id: Schema.String },
) {}

/** The payment already left pending, as it now stands. */
export class PaymentClosedError extends Schema.TaggedError<PaymentClosedError>()(
  "Payments.PaymentClosedError",
  { payment: Payment },
) {}

export interface Interface {
  /**
   * Saves a link in the business's primary ledger, once its account there is
   * open. Idempotent per business and key: a repeat with the same details
   * returns the saved link as first created, and one with other details
   * conflicts.
   */
  readonly createLink: (
    businessId: Business.ID,
    idempotencyKey: IdempotencyKey,
    details: Details,
  ) => Effect.Effect<Created, Business.NotFoundError | InactiveBusinessError | DetailsError | ConflictError>
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
    amount: bigint | null,
  ) => Effect.Effect<
    Started,
    LinkNotFoundError | LinkInactiveError | AmountError | PaymentConflictError
  >
  /**
   * Ends a pending payment of the link with the outcome a simulated provider
   * reported. A payment past its expiry is expired instead, and refused. A
   * success commits with its ledger posting, for the relay to send.
   */
  readonly simulate: (
    shareToken: string,
    paymentId: string,
    outcome: Outcome,
  ) => Effect.Effect<Payment, LinkNotFoundError | PaymentNotFoundError | PaymentClosedError>
  /** The business's links with what each collected, and its totals. */
  readonly listLinks: (businessId: Business.ID) => Effect.Effect<Overview>
  /** The business's payments, newest first, with their states and filtered totals. */
  readonly listPayments: (
    businessId: Business.ID,
    filter: Filter & { readonly before: Cursor | null },
  ) => Effect.Effect<PaymentPage, LinkNotFoundError | CursorError>
  /** One of the business's payments, with what has happened to it. */
  readonly getPayment: (businessId: Business.ID, id: string) => Effect.Effect<PaymentDetail, PaymentNotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("Payments") {}

type Row = typeof paymentLinks.$inferSelect

// A link or payment with the currency and scale of its ledger.
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

// Over payments left-joined to their posting. A succeeded payment without one,
// or whose posting the ledger won't take, needs the merchant's attention. Null
// where a link has no payment.
const state = sql<State>`case
  when ${isStatus("succeeded")} then case
    when ${ledgerPostings.state} in ('created', 'pending') then 'settling'
    when ${ledgerPostings.state} = 'posted' then 'settled'
    else 'attention'
  end
  else (${effectiveStatus})::text
end`

const inState = (value: State) => sql`(${state}) = ${value}`

// As text: a sum can pass what a JavaScript number holds exactly.
const summed = (condition: SQL) => sql<string>`coalesce(sum(${payments.amount}) filter (where ${condition}), 0)::text`

// Over the payments, and their postings, joined to the links selected; a link
// without any has none.
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

// A payment as its merchant lists it, joined to its ledger, link and posting.
const summaryColumns = {
  ...paymentColumns,
  status: effectiveStatus,
  state,
  title: paymentLinks.title,
  // Null without a posting.
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

// Every query sees the same committed state, so rows and totals agree.
const snapshot = { isolationLevel: "repeatable read", accessMode: "read only" } as const

/** The currency and scale amounts are in. */
export interface Unit {
  readonly currencyCode: string
  readonly scale: number
}

const leastText = (unit: Unit) =>
  `must be at least ${Currency.format(minimumAmount(unit.scale), unit.scale, unit.currencyCode)}`

/**
 * The amount a payment of this pricing charges, or why the request can't have
 * it. No amount is below one whole unit; a link's minimum only raises that.
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

// The first setting below one whole unit, if any.
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

// The submitted details only: the ledger comes from the server, and a repeat
// is answered with what was saved, whatever the business's ledger is now.
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
        .select({ ledger: ledgers.slug, status: businesses.status, ...inLedger })
        .from(businesses)
        .innerJoin(ledgers, eq(ledgers.slug, businesses.primaryLedger))
        .where(eq(businesses.id, businessId)),
    )

    const owner = owners[0]

    if (owner === undefined) {
      return yield* new Business.NotFoundError({ id: businessId })
    }

    // A link would take payments the ledger has no account to credit.
    if (owner.status !== "active") {
      return yield* new InactiveBusinessError({ businessId })
    }

    const unit = { currencyCode: owner.currency, scale: owner.scale }
    const below = belowUnit(details.pricing, unit)

    if (below !== undefined) {
      return yield* below
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
          ledger: owner.ledger,
          ...columnsOf(details.pricing),
        })
        .onConflictDoNothing({ target: [paymentLinks.businessId, paymentLinks.idempotencyKey] })
        .returning(),
    )

    if (inserted[0] !== undefined) {
      return { link: fromRow({ link: inserted[0], currency: owner.currency, scale: owner.scale }), created: true }
    }

    // In the ledger it was saved in, which need not be the primary one now.
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
        .select(paymentColumns)
        .from(payments)
        .innerJoin(ledgers, eq(ledgers.slug, payments.ledger))
        .where(and(eq(payments.linkId, linkId), eq(payments.idempotencyKey, idempotencyKey))),
    )

  // The payment a key already started, if the repeat asks for the same one.
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
        // Shared, so a deactivation waits until this payment is saved.
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
              amount,
              ledger: row.ledger,
              expiresAt: sql`now() + make_interval(mins => ${paymentWindowMinutes})`,
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

  // Records the money a succeeded payment brought in: from the ledger's cash
  // into the business's payable account. The cash account is seeded and only
  // an active business has links, so a missing one is a defect.
  const post = Effect.fnUntraced(function* (payment: typeof payments.$inferSelect) {
    const found = yield* database.use((db) =>
      db
        .select({ cash: platformAccounts.ledgerAccountRef, payable: businesses.primaryPayableAccountRef })
        .from(businesses)
        .leftJoin(
          platformAccounts,
          and(eq(platformAccounts.ledger, payment.ledger), eq(platformAccounts.label, "cash")),
        )
        .where(eq(businesses.id, payment.businessId)),
    )

    const cash = found[0]?.cash ?? null
    const payable = found[0]?.payable ?? null
    const completedAt = payment.completedAt

    if (cash === null || payable === null) {
      return yield* Effect.die(new Error(`no cash or payable account for payment ${payment.id} in ${payment.ledger}`))
    }

    if (completedAt === null) {
      return yield* Effect.die(new Error(`succeeded payment ${payment.id} has no completion time`))
    }

    yield* database.use((db) =>
      db.insert(ledgerPostings).values({
        id: createId("lpost"),
        businessId: payment.businessId,
        ledger: payment.ledger,
        paymentId: payment.id,
        kind: "payment",
        description: `Payment ${payment.id} via link ${payment.linkId}`,
        // To the millisecond, as it is sent.
        effectiveAt: completedAt,
        lines: [
          {
            debit_account_ref: cash,
            credit_account_ref: payable,
            amount: payment.amount.toString(),
            purpose: "payment",
          },
        ],
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

    // A payment is always in its link's ledger.
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

    // An aggregate without group by always returns its one row.
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

    const cursor = before === null
      ? null
      : yield* Effect.gen(function* () {
          const decoded = yield* Effect.fromResult(Encoding.decodeBase64UrlString(before))

          return yield* Schema.decodeEffect(cursorValue)(decoded)
        }).pipe(Effect.mapError(() => new CursorError()))

    const where = and(
      eq(payments.businessId, businessId),
      linkId === null ? undefined : eq(payments.linkId, linkId),
      filter.state === null ? undefined : inState(filter.state),
    )

    // One snapshot gives rows and totals the same clock for effective expiry,
    // and the same postings while the relay settles them.
    return yield* database.transaction(
      Effect.gen(function* () {
        const listed = yield* database.use((db) =>
          db
            .select({
              ...summaryColumns,
              // Stable across DateStyle settings, with every microsecond retained.
              at: sql<string>`to_char(${payments.createdAt} at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00'`,
            })
            .from(payments)
            .innerJoin(ledgers, eq(ledgers.slug, payments.ledger))
            .innerJoin(paymentLinks, eq(paymentLinks.id, payments.linkId))
            .leftJoin(ledgerPostings, postingOf)
            .where(
              and(
                where,
                cursor === null
                  ? undefined
                  : sql`(${payments.createdAt}, ${payments.id}) < (${cursor.at}::timestamptz, ${cursor.id})`,
              ),
            )
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

        const page = listed.slice(0, paymentPageSize)
        const last = page.at(-1)
        let next: Cursor | null = null

        if (listed.length > paymentPageSize && last !== undefined) {
          const encoded = yield* Schema.encodeEffect(cursorValue)({
            at: last.at,
            id: PaymentID.make(last.payment.id),
          }).pipe(Effect.orDie)

          next = Cursor.make(Encoding.encodeBase64Url(encoded))
        }

        return new PaymentPage({
          payments: page.map(summaryOf),
          stats: statsOf(total),
          next,
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
