import { sql } from "drizzle-orm"
import {
  check,
  foreignKey,
  index,
  pgEnum,
  pgTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core"

import { businesses } from "../business/sql.ts"
import { amount, amountValid, at } from "@pay-tty/database/columns"
import { createdAt, idempotencyKeyValid, oneLine, trimmed } from "../database/columns.ts"

export const pricingModes = ["fixed", "customer_chooses"] as const

export const pricingMode = pgEnum("payment_link_pricing_mode", pricingModes)

export const paymentLinks = pgTable(
  "payment_links",
  {
    id: text("id").primaryKey(),
    businessId: text("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "restrict" }),
    // Scoped per business for idempotent link creation.
    idempotencyKey: text("idempotency_key").notNull(),
    shareToken: text("share_token").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    // Ledger defining the currency and scale for this link and its payments.
    ledger: text("ledger").notNull(),
    pricingMode: pricingMode("pricing_mode").notNull(),
    // `amount` is set for `fixed` pricing; bounds/suggestion are optional for `customer_chooses`.
    amount: amount("amount"),
    suggestedAmount: amount("suggested_amount"),
    minimumAmount: amount("minimum_amount"),
    maximumAmount: amount("maximum_amount"),
    // Null while the link accepts new payments.
    deactivatedAt: at("deactivated_at"),
    ...createdAt,
  },
  (table) => [
    uniqueIndex("payment_links_business_id_idempotency_key_unique").on(table.businessId, table.idempotencyKey),
    uniqueIndex("payment_links_share_token_unique").on(table.shareToken),
    // Enforces that the link belongs to the business's primary ledger.
    foreignKey({
      name: "payment_links_business_ledger_fk",
      columns: [table.businessId, table.ledger],
      foreignColumns: [businesses.id, businesses.primaryLedger],
    })
      .onDelete("restrict")
      .onUpdate("cascade"),
    // Target for `payments_link_fk` so payments inherit their link's business and ledger.
    unique("payment_links_payment_target_unique").on(table.id, table.businessId, table.ledger),
    check("payment_links_idempotency_key_valid", idempotencyKeyValid(table.idempotencyKey)),
    // 43-char base64url token without a leading `-` so it is valid as an OpenSSH username.
    check("payment_links_share_token_valid", sql`${table.shareToken} ~ '^[A-Za-z0-9_][A-Za-z0-9_-]{42}$'`),
    check(
      "payment_links_title_valid",
      sql`char_length(${table.title}) between 1 and 255 and ${trimmed(table.title)} and ${oneLine(table.title)}`,
    ),
    check(
      "payment_links_description_valid",
      sql`${table.description} is null or (char_length(${table.description}) between 1 and 500 and ${trimmed(table.description)})`,
    ),
    check(
      "payment_links_pricing_settings",
      sql`case ${table.pricingMode}
        when 'fixed' then ${table.amount} is not null
          and ${table.suggestedAmount} is null
          and ${table.minimumAmount} is null
          and ${table.maximumAmount} is null
        else ${table.amount} is null
      end`,
    ),
    ...[table.amount, table.suggestedAmount, table.minimumAmount, table.maximumAmount].map(
      (column) => check(`payment_links_${column.name}_valid`, sql`${column} is null or ${amountValid(column)}`),
    ),
    check(
      "payment_links_minimum_within_maximum",
      sql`${table.minimumAmount} is null or ${table.maximumAmount} is null or ${table.minimumAmount} <= ${table.maximumAmount}`,
    ),
    check(
      "payment_links_suggested_within_bounds",
      sql`${table.suggestedAmount} is null or (
        (${table.minimumAmount} is null or ${table.suggestedAmount} >= ${table.minimumAmount})
        and (${table.maximumAmount} is null or ${table.suggestedAmount} <= ${table.maximumAmount})
      )`,
    ),
  ],
)

export const paymentStatuses = ["pending", "succeeded", "failed", "cancelled", "expired"] as const

export const paymentStatus = pgEnum("payment_status", paymentStatuses)

// Customer payment attempts against a payment link.
export const payments = pgTable(
  "payments",
  {
    id: text("id").primaryKey(),
    businessId: text("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "restrict" }),
    linkId: text("link_id").notNull(),
    // Scoped per link for idempotent payment creation.
    idempotencyKey: text("idempotency_key").notNull(),
    amount: amount("amount").notNull(),
    ledger: text("ledger").notNull(),
    status: paymentStatus("status").default("pending").notNull(),
    ...createdAt,
    expiresAt: at("expires_at").notNull(),
    // Timestamp when `status` transitioned out of `pending`.
    completedAt: at("completed_at"),
  },
  (table) => [
    foreignKey({
      name: "payments_link_fk",
      columns: [table.linkId, table.businessId, table.ledger],
      foreignColumns: [paymentLinks.id, paymentLinks.businessId, paymentLinks.ledger],
    })
      .onDelete("restrict")
      .onUpdate("cascade"),
    // Target for `ledger_postings` composite FK so postings match the payment's ledger.
    unique("payments_id_ledger_unique").on(table.id, table.ledger),
    uniqueIndex("payments_link_id_idempotency_key_unique").on(table.linkId, table.idempotencyKey),
    index("payments_business_id_created_at_id_idx").on(table.businessId, table.createdAt.desc().nullsFirst(), table.id.desc().nullsFirst()),
    index("payments_link_id_created_at_idx").on(table.linkId, table.createdAt),
    index("payments_pending_expires_at_idx").on(table.expiresAt).where(sql`${table.status} = 'pending'`),
    check("payments_idempotency_key_valid", idempotencyKeyValid(table.idempotencyKey)),
    check("payments_amount_valid", amountValid(table.amount)),
    check("payments_expires_after_created", sql`${table.expiresAt} > ${table.createdAt}`),
    check("payments_completed_with_status", sql`(${table.status} = 'pending') = (${table.completedAt} is null)`),
  ],
)
