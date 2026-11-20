import { amount, amountValid, at, identifier } from "@pay-tty/database/columns"
import { sql } from "drizzle-orm"
import { check, index, integer, pgEnum, pgTable, smallint, text } from "drizzle-orm/pg-core"

export const outcomes = ["paid", "failed"] as const

export const outcome = pgEnum("payout_outcome", outcomes)

// Payout transfers accepted by the simulated provider. Plane only reaches it over HTTP.
export const providerPayouts = pgTable(
  "provider_payouts",
  {
    providerRef: identifier("provider_ref").primaryKey(),
    // Caller-supplied idempotency key (payout ID). Duplicate sends are no-ops.
    reference: identifier("reference").notNull().unique(),
    ledger: identifier("ledger").notNull(),
    amount: amount("amount").notNull(),
    bankCode: identifier("bank_code").notNull(),
    accountNumber: identifier("account_number").notNull(),
    accountName: text("account_name").notNull(),
    sentAt: at("sent_at").defaultNow().notNull(),
    // Null while the transfer is processing.
    outcome: outcome("outcome"),
    reversedAt: at("reversed_at"),
    // When plane acknowledged the outcome's callback; until then it is sent again.
    reportedAt: at("reported_at"),
    // Each callback is retried on its own, with backoff, up to a fixed number of attempts.
    callbackAttempts: integer("callback_attempts").default(0).notNull(),
    // Null when due at once.
    nextCallbackAt: at("next_callback_at"),
    // Plane's status on the last failed attempt; null for no answer.
    callbackStatus: smallint("callback_status"),
    // Given up: never sent again.
    callbackAbandonedAt: at("callback_abandoned_at"),
  },
  (table) => [
    // Processing transfers, oldest first, for the background reporter.
    index("provider_payouts_processing_idx").on(table.sentAt).where(sql`${table.outcome} is null`),
    check("provider_payouts_amount_valid", amountValid(table.amount)),
    // Final outcomes plane hasn't acknowledged and the reporter hasn't given up on.
    index("provider_payouts_unreported_idx")
      .on(table.sentAt)
      .where(sql`${table.outcome} is not null and ${table.reportedAt} is null and ${table.callbackAbandonedAt} is null`),
    check("provider_payouts_reported_or_abandoned", sql`${table.reportedAt} is null or ${table.callbackAbandonedAt} is null`),
    check("provider_payouts_reported_final", sql`${table.reportedAt} is null or ${table.outcome} is not null`),
    check("provider_payouts_reversed_paid", sql`${table.reversedAt} is null or ${table.outcome} = 'paid'`),
  ],
)

// Deterministic outcome by account number: suffix 0000 fails; all others succeed
// (suffix 0001 succeeds here and is reversed later on the bank statement).
export const decidedOutcome = sql`(case when right(${providerPayouts.accountNumber}, 4) = '0000' then 'failed' else 'paid' end)::payout_outcome`
