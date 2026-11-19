import { type AnyColumn, sql } from "drizzle-orm"
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core"

import { businesses } from "../business/sql.ts"
import { at } from "@pay-tty/database/columns"
import { createdAt, timestamps } from "../database/columns.ts"
import { payments } from "../payments/sql.ts"
import { payouts } from "../payouts/sql.ts"

// Ledgers operated by the platform, mirrored from the ledger service with their
// fixed currency and scale.
export const ledgers = pgTable(
  "ledgers",
  {
    slug: text("slug").primaryKey(),
    currency: text("currency").notNull(),
    scale: smallint("scale").notNull(),
    // Country whose new businesses open their primary account in this ledger.
    // Evaluated once at business creation.
    countryCode: text("country_code"),
    isCountryDefault: boolean("is_country_default").default(false).notNull(),
    ...createdAt,
  },
  (table) => [
    check("ledgers_slug_not_blank", sql`${table.slug} ~ '\\S'`),
    check("ledgers_currency_valid", sql`${table.currency} ~ '^[A-Z]{3}$'`),
    check("ledgers_scale_valid", sql`${table.scale} between 0 and 4`),
    check("ledgers_country_code_valid", sql`${table.countryCode} ~ '^[A-Z]{2}$'`),
    check(
      "ledgers_country_default_has_country",
      sql`not ${table.isCountryDefault} or ${table.countryCode} is not null`,
    ),
    uniqueIndex("ledgers_country_default_unique")
      .on(table.countryCode)
      .where(sql`${table.isCountryDefault}`),
    // Target for `businesses` composite `(primary_ledger, currency_code)` FK.
    unique("ledgers_slug_currency_unique").on(table.slug, table.currency),
  ],
)

export const labels = ["cash", "fee", "receivable", "payouts_clearing"] as const

export const platformAccountLabel = pgEnum("platform_account_label", labels)

// Platform accounts per ledger, shared across all businesses in that ledger.
export const platformAccounts = pgTable(
  "platform_accounts",
  {
    ledger: text("ledger")
      .notNull()
      .references(() => ledgers.slug, { onDelete: "cascade", onUpdate: "cascade" }),
    label: platformAccountLabel("label").notNull(),
    ledgerAccountRef: text("ledger_account_ref").notNull(),
    ...timestamps,
  },
  (table) => [primaryKey({ columns: [table.ledger, table.label] })],
)

export const postingStates = ["created", "pending", "posted", "voided", "refused"] as const

export const postingState = pgEnum("ledger_posting_state", postingStates)

export const resolutions = ["capture", "void"] as const

export const postingResolution = pgEnum("ledger_posting_resolution", resolutions)

/**
 * Predicate matching a pending posting whose ledger state disagrees with
 * plane's requested resolution (either refused, or resolved to the opposite state).
 */
export const resolutionMismatched = (posting: { readonly resolution: AnyColumn; readonly state: AnyColumn }) =>
  sql<boolean>`(${posting.resolution} is not null and (${posting.state} = 'refused'
    or (${posting.resolution} = 'capture' and ${posting.state} = 'voided')
    or (${posting.resolution} = 'void' and ${posting.state} = 'posted')))`.mapWith(Boolean)

/** Stored journal line with `amount` serialized as a minor-unit integer string. */
export interface PostingLine {
  readonly debit_account_ref: string
  readonly credit_account_ref: string
  readonly amount: string
  readonly purpose: string
}

// Transactional outbox for ledger journal postings and resolutions. Payloads
// are immutable once inserted so retries are idempotent.
export const ledgerPostings = pgTable(
  "ledger_postings",
  {
    // Used as the ledger's `Idempotency-Key` (`${id}` for posts, `${id}:${resolution}` for resolutions).
    id: text("id").primaryKey(),
    businessId: text("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "restrict" }),
    ledger: text("ledger")
      .notNull()
      .references(() => ledgers.slug, { onUpdate: "cascade" }),
    // Domain cause; exactly one is non-null (`ledger_postings_one_cause`).
    paymentId: text("payment_id").references(() => payments.id, { onDelete: "restrict" }),
    payoutId: text("payout_id").references(() => payouts.id, { onDelete: "restrict" }),
    kind: text("kind").notNull(),
    // Entry description shown on the merchant's statement.
    description: text("description").notNull(),
    lines: jsonb("lines").$type<ReadonlyArray<PostingLine>>().notNull(),
    // True when the entry opens a pending authorization to be captured or voided later.
    pending: boolean("pending").default(false).notNull(),
    // Target resolution (`capture` or `void`) set by plane for the relay to send.
    resolution: postingResolution("resolution"),
    state: postingState("state").default("created").notNull(),
    // Ledger reference for the initial entry (posted or pending).
    journalRef: text("journal_ref"),
    // Ledger reference for the resolving entry (`capture` or `void`).
    resolutionRef: text("resolution_ref"),
    errorCode: text("error_code"),
    attempts: integer("attempts").default(0).notNull(),
    // Timestamp of the first relay attempt; anchors the hold-confirmation timeout.
    firstAttemptAt: at("first_attempt_at"),
    lastAttemptAt: at("last_attempt_at"),
    // Lease fence and expiration (`claimed_until`) for the active relay pass.
    claimId: text("claim_id"),
    claimedUntil: at("claimed_until"),
    ...createdAt,
    // Timestamp when the ledger recorded the initial entry.
    recordedAt: at("recorded_at"),
  },
  (table) => [
    check("ledger_postings_one_cause", sql`num_nonnulls(${table.paymentId}, ${table.payoutId}) = 1`),
    // Composite FKs ensure the posting's ledger matches its payment or payout.
    foreignKey({
      name: "ledger_postings_payment_ledger_fk",
      columns: [table.paymentId, table.ledger],
      foreignColumns: [payments.id, payments.ledger],
    }).onUpdate("cascade"),
    foreignKey({
      name: "ledger_postings_payout_ledger_fk",
      columns: [table.payoutId, table.ledger],
      foreignColumns: [payouts.id, payouts.ledger],
    }).onUpdate("cascade"),
    check(
      "ledger_postings_state_shape",
      sql`(${table.state} = 'created'
          and ${table.journalRef} is null and ${table.resolutionRef} is null and ${table.errorCode} is null)
        or (${table.state} = 'pending'
          and ${table.journalRef} is not null and ${table.resolutionRef} is null and ${table.errorCode} is null)
        or (${table.state} = 'posted'
          and ${table.journalRef} is not null and ${table.errorCode} is null
          and (${table.resolutionRef} is not null) = ${table.pending})
        or (${table.state} = 'voided'
          and ${table.journalRef} is not null and ${table.resolutionRef} is not null and ${table.errorCode} is null)
        or (${table.state} = 'refused'
          and ${table.errorCode} is not null and ${table.resolutionRef} is null)`,
    ),
    check("ledger_postings_pending_states", sql`${table.state} not in ('pending', 'voided') or ${table.pending}`),
    check(
      "ledger_postings_resolution_shape",
      sql`(${table.resolution} is null or (${table.pending} and ${table.state} <> 'created'))
        and (not ${table.pending} or ${table.state} not in ('posted', 'voided') or ${table.resolution} is not null)`,
    ),
    check("ledger_postings_recorded_with_journal", sql`(${table.journalRef} is null) = (${table.recordedAt} is null)`),
    check("ledger_postings_first_attempt_with_attempts", sql`(${table.attempts} = 0) = (${table.firstAttemptAt} is null)`),
    check("ledger_postings_claimed_together", sql`(${table.claimId} is null) = (${table.claimedUntil} is null)`),
    uniqueIndex("ledger_postings_payment_unique").on(table.paymentId).where(sql`${table.paymentId} is not null`),
    uniqueIndex("ledger_postings_payout_unique").on(table.payoutId).where(sql`${table.payoutId} is not null`),
    index("ledger_postings_created_idx").on(table.createdAt).where(sql`${table.state} = 'created'`),
    index("ledger_postings_resolving_idx")
      .on(table.createdAt)
      .where(sql`${table.state} = 'pending' and ${table.resolution} is not null`),
    index("ledger_postings_mismatched_idx").on(table.businessId, table.ledger).where(resolutionMismatched(table)),
  ],
)
