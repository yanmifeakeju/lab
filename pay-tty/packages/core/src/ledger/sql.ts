import { sql } from "drizzle-orm"
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
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core"

import { businesses } from "../business/sql.ts"
import { createdAt, timestamps } from "../database/columns.ts"
import { payments } from "../payments/sql.ts"

// The ledgers the platform operates, mirrored from the ledger service with the
// currency and scale it fixes for every amount. Rows, not a type: ledgers come
// and go without a migration.
export const ledgers = pgTable(
  "ledgers",
  {
    slug: text("slug").primaryKey(),
    currency: text("currency").notNull(),
    scale: smallint("scale").notNull(),
    // The ledger a new business from this country opens its primary account
    // in. Read once, at business creation; reassigning it moves no one.
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
    // The target of businesses' (primary_ledger, currency_code) foreign key.
    unique("ledgers_slug_currency_unique").on(table.slug, table.currency),
  ],
)

export const labels = ["cash", "fee"] as const

export const platformAccountLabel = pgEnum("platform_account_label", labels)

// Each ledger's platform accounts, shared by every business in it.
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

export const postingStates = ["created", "pending", "posted", "voided", "expired", "refused"] as const

export const postingState = pgEnum("ledger_posting_state", postingStates)

/** One line of a posting, as stored: the amount is minor units as text. */
export interface PostingLine {
  readonly debit_account_ref: string
  readonly credit_account_ref: string
  readonly amount: string
  readonly purpose: string
}

const at = (name: string) => timestamp(name, { withTimezone: true, mode: "date" })

// One movement of a merchant's money that plane asks the ledger to make,
// written with its cause. The payload is fixed at creation, so every retry
// sends the same entry. Rows are never deleted.
export const ledgerPostings = pgTable(
  "ledger_postings",
  {
    // Also the ledger's Idempotency-Key.
    id: text("id").primaryKey(),
    businessId: text("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "restrict" }),
    ledger: text("ledger")
      .notNull()
      .references(() => ledgers.slug, { onUpdate: "cascade" }),
    // The cause. Exactly one is set; refunds and payouts join later.
    paymentId: text("payment_id").references(() => payments.id, { onDelete: "restrict" }),
    kind: text("kind").notNull(),
    // Written for the merchant's statement: the link's title as it was when
    // the payment was posted.
    description: text("description").notNull(),
    effectiveAt: at("effective_at").notNull(),
    lines: jsonb("lines").$type<ReadonlyArray<PostingLine>>().notNull(),
    state: postingState("state").default("created").notNull(),
    // The first entry: posted, or the pending authorization.
    journalRef: text("journal_ref"),
    // The capture, void or expiry entry, when it went through pending.
    resolutionRef: text("resolution_ref"),
    errorCode: text("error_code"),
    attempts: integer("attempts").default(0).notNull(),
    lastAttemptAt: at("last_attempt_at"),
    // The relay pass leasing the row, until claimed_until. Its writes match
    // claim_id, so a pass whose lease was taken over changes nothing. Both
    // stay once the row resolves, naming the pass that last held it.
    claimId: text("claim_id"),
    claimedUntil: at("claimed_until"),
    ...createdAt,
    // When the ledger accepted the first entry.
    recordedAt: at("recorded_at"),
  },
  (table) => [
    check("ledger_postings_one_cause", sql`num_nonnulls(${table.paymentId}) = 1`),
    // A payment's posting is always in the payment's own ledger.
    foreignKey({
      name: "ledger_postings_payment_ledger_fk",
      columns: [table.paymentId, table.ledger],
      foreignColumns: [payments.id, payments.ledger],
    }).onUpdate("cascade"),
    check(
      "ledger_postings_state_shape",
      sql`(${table.state} = 'created'
          and ${table.journalRef} is null and ${table.resolutionRef} is null and ${table.errorCode} is null)
        or (${table.state} = 'pending'
          and ${table.journalRef} is not null and ${table.resolutionRef} is null and ${table.errorCode} is null)
        or (${table.state} = 'posted'
          and ${table.journalRef} is not null and ${table.errorCode} is null)
        or (${table.state} in ('voided', 'expired')
          and ${table.journalRef} is not null and ${table.resolutionRef} is not null and ${table.errorCode} is null)
        or (${table.state} = 'refused'
          and ${table.errorCode} is not null and ${table.resolutionRef} is null)`,
    ),
    check("ledger_postings_recorded_with_journal", sql`(${table.journalRef} is null) = (${table.recordedAt} is null)`),
    check("ledger_postings_claimed_together", sql`(${table.claimId} is null) = (${table.claimedUntil} is null)`),
    uniqueIndex("ledger_postings_payment_unique").on(table.paymentId).where(sql`${table.paymentId} is not null`),
    index("ledger_postings_created_idx").on(table.createdAt).where(sql`${table.state} = 'created'`),
  ],
)
