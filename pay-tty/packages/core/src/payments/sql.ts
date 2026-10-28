import { sql } from "drizzle-orm"
import {
  type AnyPgColumn,
  bigint,
  check,
  foreignKey,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core"

import { businesses } from "../business/sql.ts"
import { createdAt, space } from "../database/columns.ts"

export const pricingModes = ["fixed", "customer_chooses"] as const

export const pricingMode = pgEnum("payment_link_pricing_mode", pricingModes)

// Every amount is in minor units of its ledger's currency, at its scale.
const amount = (name: string) => bigint(name, { mode: "bigint" })

// The largest amount a link takes: every amount survives JSON and a
// JavaScript number unchanged.
export const maxAmount = BigInt(Number.MAX_SAFE_INTEGER)

const amountValid = (column: AnyPgColumn) => sql`${column} between 1 and ${sql.raw(String(maxAmount))}`

const at = (name: string) => timestamp(name, { withTimezone: true, mode: "date" })

const idempotencyKeyValid = (column: AnyPgColumn) => sql`${column} ~ '^[!-~]{1,255}$'`

const trimmed = (column: AnyPgColumn) => sql`${column} !~ ${sql.raw(`'^${space}|${space}$'`)}`

// What Payments.isOneLine refuses, with Cc spelled out: Postgres has no \p{Cc},
// and text can't hold NUL.
const oneLine = (column: AnyPgColumn) =>
  sql`${column} !~ ${sql.raw(String.raw`'[\u0001-\u001f\u007f-\u009f\u2028\u2029]'`)}`

export const paymentLinks = pgTable(
  "payment_links",
  {
    id: text("id").primaryKey(),
    businessId: text("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "restrict" }),
    // A repeat with this key returns the link instead of making another.
    idempotencyKey: text("idempotency_key").notNull(),
    shareToken: text("share_token").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    // Fixes the currency and scale of every amount on the link and its
    // payments.
    ledger: text("ledger").notNull(),
    pricingMode: pricingMode("pricing_mode").notNull(),
    // Fixed pricing's amount; customer-chosen pricing's optional settings.
    amount: amount("amount"),
    suggestedAmount: amount("suggested_amount"),
    minimumAmount: amount("minimum_amount"),
    maximumAmount: amount("maximum_amount"),
    // Null while the link takes payments. Links are never deleted.
    deactivatedAt: at("deactivated_at"),
    ...createdAt,
  },
  (table) => [
    uniqueIndex("payment_links_business_id_idempotency_key_unique").on(table.businessId, table.idempotencyKey),
    uniqueIndex("payment_links_share_token_unique").on(table.shareToken),
    // Only a ledger the business holds an account in. When a business has
    // accounts in more than one ledger, this names that accounts table.
    foreignKey({
      name: "payment_links_business_ledger_fk",
      columns: [table.businessId, table.ledger],
      foreignColumns: [businesses.id, businesses.primaryLedger],
    })
      .onDelete("restrict")
      .onUpdate("cascade"),
    // What a payment's foreign key names, so a payment is always in its
    // link's business and ledger.
    unique("payment_links_payment_target_unique").on(table.id, table.businessId, table.ledger),
    check("payment_links_idempotency_key_valid", idempotencyKeyValid(table.idempotencyKey)),
    // Base64url, never starting with "-": it is a customer's SSH user name.
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

// One customer's attempt to pay a link. A link has any number of them.
export const payments = pgTable(
  "payments",
  {
    id: text("id").primaryKey(),
    businessId: text("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "restrict" }),
    linkId: text("link_id").notNull(),
    // A repeat with this key returns the payment instead of starting another.
    idempotencyKey: text("idempotency_key").notNull(),
    // The link's fixed amount, or the one the customer chose within its bounds.
    amount: amount("amount").notNull(),
    // The link's.
    ledger: text("ledger").notNull(),
    status: paymentStatus("status").default("pending").notNull(),
    ...createdAt,
    expiresAt: at("expires_at").notNull(),
    // When it left pending.
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
    // What a posting names, so it is always in its payment's ledger.
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
