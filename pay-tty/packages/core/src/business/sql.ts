import { sql } from "drizzle-orm"
import {
  boolean,
  check,
  index,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core"

import { createdAt, timestamps } from "../database/columns.ts"
import { ledgers } from "../ledger/sql.ts"
import { principals } from "../principal/sql.ts"

export const statuses = ["created", "active"] as const

export const status = pgEnum("business_status", statuses)

export const businesses = pgTable(
  "businesses",
  {
    id: text("id").primaryKey(),
    // Fixed at creation: the ledger holder carries this name and rejects a
    // different one when the business onboards onto another ledger.
    name: text("name").notNull(),
    // Assigned by the server; every business is NGN for now.
    currencyCode: text("currency_code").default("NGN").notNull(),
    // Active once the holder and default payable account are recorded.
    status: status("status").default("created").notNull(),
    // One holder across every ledger the business is in.
    ledgerHolderRef: text("ledger_holder_ref"),
    ...timestamps,
  },
  (table) => [check("businesses_currency_code_valid", sql`${table.currencyCode} ~ '^[A-Z]{3}$'`)],
)

export const businessPrincipals = pgTable(
  "business_principals",
  {
    principalId: text("principal_id")
      .primaryKey()
      .references(() => principals.id, { onDelete: "restrict" }),
    businessId: text("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "restrict" }),
    ...createdAt,
  },
  (table) => [index("business_principals_business_id_idx").on(table.businessId)],
)

// The ledgers a business is in, with its payable account in each. A row is
// written only once the ledger has created that account.
export const businessLedgers = pgTable(
  "business_ledgers",
  {
    businessId: text("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    ledger: text("ledger")
      .notNull()
      .references(() => ledgers.slug, { onDelete: "restrict", onUpdate: "cascade" }),
    isDefault: boolean("is_default").default(false).notNull(),
    payableAccountRef: text("payable_account_ref").notNull(),
    ...createdAt,
  },
  (table) => [
    primaryKey({ columns: [table.businessId, table.ledger] }),
    uniqueIndex("business_ledgers_payable_account_ref_unique").on(table.payableAccountRef),
    // Uniqueness only: a business has no default until its first account is
    // recorded, and activation requires one.
    uniqueIndex("business_ledgers_default_unique")
      .on(table.businessId)
      .where(sql`${table.isDefault}`),
  ],
)
