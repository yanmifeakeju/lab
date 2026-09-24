import { sql } from "drizzle-orm"
import {
  check,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
} from "drizzle-orm/pg-core"

import { createdAt, timestamps } from "../../database/columns.ts"

// The ledgers the platform operates, mirrored from the ledger service with the
// currency and scale it fixes for every amount. Rows, not a type: ledgers come
// and go without a migration.
export const ledgers = pgTable(
  "ledgers",
  {
    slug: text("slug").primaryKey(),
    currency: text("currency").notNull(),
    scale: smallint("scale").notNull(),
    ...createdAt,
  },
  (table) => [
    check("ledgers_slug_not_blank", sql`${table.slug} ~ '\\S'`),
    check("ledgers_currency_valid", sql`${table.currency} ~ '^[A-Z]{3}$'`),
    check("ledgers_scale_valid", sql`${table.scale} between 0 and 4`),
  ],
)

export const labels = ["cash", "fee"] as const

export const platformAccountLabel = pgEnum("platform_account_label", labels)

// Each ledger's platform accounts, which every business uses unless it
// overrides one.
export const ledgerPlatformAccounts = pgTable(
  "ledger_platform_accounts",
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
