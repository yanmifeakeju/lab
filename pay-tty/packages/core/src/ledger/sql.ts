import { sql } from "drizzle-orm"
import {
  boolean,
  check,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core"

import { createdAt, timestamps } from "../database/columns.ts"

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
