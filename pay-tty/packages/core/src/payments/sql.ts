import { sql } from "drizzle-orm"
import { type AnyPgColumn, bigint, check, pgEnum, pgTable, smallint, text, uniqueIndex } from "drizzle-orm/pg-core"

import { businesses } from "../business/sql.ts"
import { createdAt, space } from "../database/columns.ts"

export const pricingModes = ["fixed", "customer_chooses"] as const

export const pricingMode = pgEnum("payment_link_pricing_mode", pricingModes)

const amount = (name: string) => bigint(name, { mode: "bigint" })

// The largest amount a link takes: every amount survives JSON and a
// JavaScript number unchanged.
export const maxAmount = BigInt(Number.MAX_SAFE_INTEGER)

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
    ...createdAt,
  },
  (table) => [
    uniqueIndex("payment_links_business_id_idempotency_key_unique").on(table.businessId, table.idempotencyKey),
    uniqueIndex("payment_links_share_token_unique").on(table.shareToken),
    check("payment_links_idempotency_key_valid", sql`${table.idempotencyKey} ~ '^[!-~]{1,255}$'`),
    check("payment_links_share_token_valid", sql`${table.shareToken} ~ '^[A-Za-z0-9_-]{43}$'`),
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
      (column) =>
        check(
          `payment_links_${column.name}_valid`,
          sql`${column} is null or ${column} between 1 and ${sql.raw(String(maxAmount))}`,
        ),
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
