import { sql } from "drizzle-orm"
import {
  type AnyPgColumn,
  bigint,
  check,
  foreignKey,
  index,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core"

import { businesses } from "../business/sql.ts"
import { createdAt, space } from "../database/columns.ts"

export const pricingModes = ["fixed", "customer_chooses"] as const

export const pricingMode = pgEnum("payment_link_pricing_mode", pricingModes)

const amount = (name: string) => bigint(name, { mode: "bigint" })

// The largest amount a link takes: every amount survives JSON and a
// JavaScript number unchanged.
export const maxAmount = BigInt(Number.MAX_SAFE_INTEGER)

const amountValid = (column: AnyPgColumn) => sql`${column} between 1 and ${sql.raw(String(maxAmount))}`

const at = (name: string) => timestamp(name, { withTimezone: true, mode: "date" })

const idempotencyKeyValid = (column: AnyPgColumn) => sql`${column} ~ '^[!-~]{1,255}$'`

const trimmed = (column: AnyPgColumn) => sql`${column} !~ ${sql.raw(`'^${space}|${space}$'`)}`

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
    // The business's primary ledger's when the link was created.
    currencyCode: text("currency_code").notNull(),
    scale: smallint("scale").notNull(),
    pricingMode: pricingMode("pricing_mode").notNull(),
    // Fixed pricing's amount; customer-chosen pricing's optional settings.
    amountMinor: amount("amount_minor"),
    suggestedAmountMinor: amount("suggested_amount_minor"),
    minimumAmountMinor: amount("minimum_amount_minor"),
    maximumAmountMinor: amount("maximum_amount_minor"),
    // Null while the link takes payments. Links are never deleted.
    deactivatedAt: at("deactivated_at"),
    ...createdAt,
  },
  (table) => [
    uniqueIndex("payment_links_business_id_idempotency_key_unique").on(table.businessId, table.idempotencyKey),
    uniqueIndex("payment_links_share_token_unique").on(table.shareToken),
    // What a payment's foreign key names, so a payment is always in its
    // link's business, currency, and scale.
    unique("payment_links_payment_target_unique").on(table.id, table.businessId, table.currencyCode, table.scale),
    check("payment_links_idempotency_key_valid", idempotencyKeyValid(table.idempotencyKey)),
    // Base64url, never starting with "-": it is a customer's SSH user name.
    check("payment_links_share_token_valid", sql`${table.shareToken} ~ '^[A-Za-z0-9_][A-Za-z0-9_-]{42}$'`),
    check(
      "payment_links_title_valid",
      sql`${table.title} <> '' and char_length(${table.title}) <= 255 and ${trimmed(table.title)}`,
    ),
    check(
      "payment_links_description_valid",
      sql`${table.description} is null or (${table.description} <> '' and char_length(${table.description}) <= 500 and ${trimmed(table.description)})`,
    ),
    check("payment_links_currency_code_valid", sql`${table.currencyCode} ~ '^[A-Z]{3}$'`),
    check("payment_links_scale_valid", sql`${table.scale} between 0 and 4`),
    check(
      "payment_links_pricing_settings",
      sql`case ${table.pricingMode}
        when 'fixed' then ${table.amountMinor} is not null
          and ${table.suggestedAmountMinor} is null
          and ${table.minimumAmountMinor} is null
          and ${table.maximumAmountMinor} is null
        else ${table.amountMinor} is null
      end`,
    ),
    ...[table.amountMinor, table.suggestedAmountMinor, table.minimumAmountMinor, table.maximumAmountMinor].map(
      (column) => check(`payment_links_${column.name}_valid`, sql`${column} is null or ${amountValid(column)}`),
    ),
    check(
      "payment_links_minimum_within_maximum",
      sql`${table.minimumAmountMinor} is null or ${table.maximumAmountMinor} is null or ${table.minimumAmountMinor} <= ${table.maximumAmountMinor}`,
    ),
    check(
      "payment_links_suggested_within_bounds",
      sql`${table.suggestedAmountMinor} is null or (
        (${table.minimumAmountMinor} is null or ${table.suggestedAmountMinor} >= ${table.minimumAmountMinor})
        and (${table.maximumAmountMinor} is null or ${table.suggestedAmountMinor} <= ${table.maximumAmountMinor})
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
    amountMinor: amount("amount_minor").notNull(),
    currencyCode: text("currency_code").notNull(),
    scale: smallint("scale").notNull(),
    status: paymentStatus("status").default("pending").notNull(),
    ...createdAt,
    expiresAt: at("expires_at").notNull(),
    // When it left pending.
    completedAt: at("completed_at"),
  },
  (table) => [
    foreignKey({
      name: "payments_link_fk",
      columns: [table.linkId, table.businessId, table.currencyCode, table.scale],
      foreignColumns: [paymentLinks.id, paymentLinks.businessId, paymentLinks.currencyCode, paymentLinks.scale],
    }).onDelete("restrict"),
    uniqueIndex("payments_link_id_idempotency_key_unique").on(table.linkId, table.idempotencyKey),
    index("payments_link_id_created_at_idx").on(table.linkId, table.createdAt),
    index("payments_pending_expires_at_idx").on(table.expiresAt).where(sql`${table.status} = 'pending'`),
    check("payments_idempotency_key_valid", idempotencyKeyValid(table.idempotencyKey)),
    check("payments_amount_minor_valid", amountValid(table.amountMinor)),
    check("payments_expires_after_created", sql`${table.expiresAt} > ${table.createdAt}`),
    check("payments_completed_with_status", sql`(${table.status} = 'pending') = (${table.completedAt} is null)`),
  ],
)
