import { type AnyColumn, isNotNull, sql } from "drizzle-orm"
import {
  type AnyPgColumn,
  check,
  date,
  foreignKey,
  index,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core"

import { businesses } from "../business/sql.ts"
import { amount, amountValid, at } from "@pay-tty/database/columns"
import { createdAt, idempotencyKeyValid, timestamps, trimmed } from "../database/columns.ts"

export const modes = ["manual", "automatic"] as const

export const mode = pgEnum("payout_mode", modes)

// Origin of the payout: requested manually by the business, or created by the
// daily automatic scheduler.
export const triggers = ["manual", "scheduled"] as const

export const trigger = pgEnum("payout_trigger", triggers)

/**
 * Predicate matching confirmed payouts (excludes `created`, `expired`, and
 * `cancelled` drafts). Used by `payouts_listed_idx` and `Payouts.list`.
 */
export const listable = (table: { readonly status: AnyColumn }) =>
  sql`${table.status} not in ('created', 'expired', 'cancelled')`

// Payout lifecycle states. Drafts start `created` and transition to `requested`
// on confirmation, `expired` on TTL lapse, or `cancelled` when invalidated.
export const statuses = [
  "created",
  "requested",
  "held",
  "sent",
  "paid",
  "failed",
  "rejected",
  "cancelled",
  "expired",
  "attention",
] as const

export const status = pgEnum("payout_status", statuses)

// 3-digit CBN bank code and 10-digit NUBAN account number.
const bankCodeValid = (column: AnyPgColumn) => sql`${column} ~ '^[0-9]{3}$'`

const accountNumberValid = (column: AnyPgColumn) => sql`${column} ~ '^[0-9]{10}$'`

const accountNameValid = (column: AnyPgColumn) => sql`${column} <> '' and ${trimmed(column)}`

// Per-business, per-ledger payout configuration. A row is inserted when the
// business first saves a destination bank account for that ledger.
export const payoutSettings = pgTable(
  "payout_settings",
  {
    businessId: text("business_id").notNull(),
    ledger: text("ledger").notNull(),
    mode: mode("mode").default("manual").notNull(),
    bankCode: text("bank_code").notNull(),
    accountNumber: text("account_number").notNull(),
    // When the business last switched to automatic: the daily run pays it out
    // from the next midnight UTC after, so a switch takes effect at the next run.
    automaticSince: at("automatic_since"),
    // The last UTC date the daily run settled for this business, paid out or
    // not; a run that failed leaves it, so the next check retries the day.
    lastRunOn: date("last_run_on", { mode: "string" }),
    updatedAt: timestamps.updatedAt,
  },
  (table) => [
    primaryKey({ columns: [table.businessId, table.ledger] }),
    // Enforces that settings belong to the business's primary ledger.
    foreignKey({
      name: "payout_settings_business_ledger_fk",
      columns: [table.businessId, table.ledger],
      foreignColumns: [businesses.id, businesses.primaryLedger],
    })
      .onDelete("restrict")
      .onUpdate("cascade"),
    check("payout_settings_automatic_since", sql`(${table.mode} = 'automatic') = (${table.automaticSince} is not null)`),
    check("payout_settings_bank_code_valid", bankCodeValid(table.bankCode)),
    check("payout_settings_account_number_valid", accountNumberValid(table.accountNumber)),
  ],
)

// Payouts to a business's bank account. Once confirmed (`requested`), a
// pending hold is placed in the ledger before the payout is sent to the provider.
export const payouts = pgTable(
  "payouts",
  {
    id: text("id").primaryKey(),
    businessId: text("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "restrict" }),
    ledger: text("ledger").notNull(),
    amount: amount("amount").notNull(),
    trigger: trigger("trigger").notNull(),
    // The UTC date of the daily run (`scheduled` trigger only); the business's timezone later.
    scheduledFor: date("scheduled_for", { mode: "string" }),
    // Snapshot of the destination bank account at creation time.
    bankCode: text("bank_code").notNull(),
    accountNumber: text("account_number").notNull(),
    accountName: text("account_name").notNull(),
    status: status("status").default("created").notNull(),
    // Idempotency key for scheduled payouts; null for manual payouts (confirmed by ID).
    idempotencyKey: text("idempotency_key"),
    providerRef: text("provider_ref"),
    ...createdAt,
    // When a created draft expires if unconfirmed; fixed at creation.
    expiresAt: at("expires_at"),
    // Timestamp of the initial send; anchors the status-check schedule.
    sentAt: at("sent_at"),
    // Timestamp of the most recent status check; used to space retry checks.
    settleAttemptedAt: at("settle_attempted_at"),
    // When the provider is next asked: the first check from the send, then the
    // schedule after each `pending` response.
    nextCheckAt: at("next_check_at"),
    // Since when status checks have failed without an answer; cleared by any answer.
    checkFailingSince: at("check_failing_since"),
    completedAt: at("completed_at"),
  },
  (table) => [
    foreignKey({
      name: "payouts_settings_fk",
      columns: [table.businessId, table.ledger],
      foreignColumns: [payoutSettings.businessId, payoutSettings.ledger],
    })
      .onDelete("restrict")
      .onUpdate("cascade"),
    // Target for ledger_postings composite FK so postings match the payout's ledger.
    unique("payouts_id_ledger_unique").on(table.id, table.ledger),
    // Scoped by trigger so manual keys cannot collide with scheduled keys.
    uniqueIndex("payouts_business_id_trigger_idempotency_key_unique")
      .on(table.businessId, table.trigger, table.idempotencyKey)
      .where(isNotNull(table.idempotencyKey)),
    // At most one scheduled payout per business, ledger, and day.
    uniqueIndex("payouts_scheduled_unique")
      .on(table.businessId, table.ledger, table.scheduledFor)
      .where(sql`${table.scheduledFor} is not null`),
    // Unconfirmed drafts for expiration sweeps.
    index("payouts_created_idx").on(table.expiresAt).where(sql`${table.status} = 'created'`),
    // Counts open drafts per business and ledger to enforce `draftLimit`.
    index("payouts_open_drafts_idx")
      .on(table.businessId, table.ledger, table.expiresAt)
      .where(sql`${table.status} = 'created'`),
    // Dispatcher queues: held payouts to send, and sent payouts to poll for status.
    index("payouts_held_idx").on(table.createdAt).where(sql`${table.status} = 'held'`),
    index("payouts_due_idx").on(table.nextCheckAt).where(sql`${table.status} = 'sent'`),
    // Drafts are kept but never listed, so the list never walks past them.
    index("payouts_listed_idx")
      .on(table.businessId, table.createdAt.desc().nullsFirst(), table.id.desc().nullsFirst())
      .where(listable(table)),
    check("payouts_idempotency_key_valid", idempotencyKeyValid(table.idempotencyKey)),
    // The minimum depends on the currency, so the service checks it.
    check("payouts_amount_valid", amountValid(table.amount)),
    check("payouts_scheduled_has_date", sql`(${table.trigger} = 'scheduled') = (${table.scheduledFor} is not null)`),
    check("payouts_bank_code_valid", bankCodeValid(table.bankCode)),
    check("payouts_account_number_valid", accountNumberValid(table.accountNumber)),
    check("payouts_account_name_valid", accountNameValid(table.accountName)),
    // Never sent before it was held, and anything paid was sent first.
    check(
      "payouts_sent_with_status",
      sql`(${table.status} in ('created', 'requested', 'held', 'rejected', 'cancelled', 'expired')
          and ${table.sentAt} is null and ${table.providerRef} is null)
        or (${table.status} in ('sent', 'paid') and ${table.sentAt} is not null)
        or ${table.status} in ('failed', 'attention')`,
    ),
    check("payouts_created_expires", sql`${table.status} <> 'created' or ${table.expiresAt} is not null`),
    check("payouts_paid_has_ref", sql`${table.status} <> 'paid' or (${table.providerRef} is not null and ${table.providerRef} ~ '\\S')`),
    check("payouts_sent_has_next_check", sql`${table.status} <> 'sent' or ${table.nextCheckAt} is not null`),
    check(
      "payouts_completed_with_status",
      sql`(${table.status} in ('paid', 'failed', 'rejected', 'cancelled', 'expired')) = (${table.completedAt} is not null)`,
    ),
  ],
)
