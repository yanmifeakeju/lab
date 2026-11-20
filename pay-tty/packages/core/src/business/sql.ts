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

import { createdAt, space, timestamps } from "../database/columns.ts"
import { ledgers } from "../ledger/sql.ts"
import { principals } from "../principal/sql.ts"
import { identifier } from "@pay-tty/database/columns"

export const statuses = ["created", "active"] as const

export const status = pgEnum("business_status", statuses)

// Supported countries and their trading currencies. Enforced in SQL by
// `businesses_currency_code_matches_country`.
export const currencies = { NG: "NGN", US: "USD" } as const

export const countries = ["NG", "US"] as const satisfies ReadonlyArray<keyof typeof currencies>

export const businesses = pgTable(
  "businesses",
  {
    id: identifier("id").primaryKey(),
    // Fixed at creation: the ledger holder carries it and rejects another name on a new ledger.
    name: text("name").notNull(),
    countryCode: identifier("country_code").default("NG").notNull(),
    // Server-derived from `country_code`.
    currencyCode: identifier("currency_code").notNull(),
    // The country's default ledger at creation; kept even if that default moves.
    primaryLedger: identifier("primary_ledger").notNull(),
    // Populated together once the payable account is opened in the ledger.
    primaryPayableAccountRef: identifier("primary_payable_account_ref"),
    ledgerHolderRef: identifier("ledger_holder_ref"),
    status: status("status").default("created").notNull(),
    ...timestamps,
  },
  (table) => [
    check("businesses_name_trimmed", sql`${table.name} !~ ${sql.raw(`'^${space}|${space}$'`)}`),
    check("businesses_country_code_valid", sql`${table.countryCode} in ('NG', 'US')`),
    check(
      "businesses_currency_code_matches_country",
      sql`(${table.countryCode}, ${table.currencyCode}) in (('NG', 'NGN'), ('US', 'USD'))`,
    ),
    check(
      "businesses_holder_with_account",
      sql`(${table.ledgerHolderRef} is null) = (${table.primaryPayableAccountRef} is null)`,
    ),
    check(
      "businesses_active_has_account",
      sql`${table.status} <> 'active' or ${table.primaryPayableAccountRef} is not null`,
    ),
    // Composite FK ensures `primary_ledger` uses `currency_code`.
    foreignKey({
      name: "businesses_primary_ledger_fk",
      columns: [table.primaryLedger, table.currencyCode],
      foreignColumns: [ledgers.slug, ledgers.currency],
    })
      .onDelete("restrict")
      .onUpdate("cascade"),
    uniqueIndex("businesses_primary_payable_account_ref_unique").on(table.primaryPayableAccountRef),
    // Target for composite FKs from `payment_links` and `payout_settings`.
    unique("businesses_id_primary_ledger_unique").on(table.id, table.primaryLedger),
  ],
)

export const businessPrincipals = pgTable(
  "business_principals",
  {
    principalId: identifier("principal_id")
      .primaryKey()
      .references(() => principals.id, { onDelete: "restrict" }),
    businessId: identifier("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "restrict" }),
    ...createdAt,
  },
  (table) => [index("business_principals_business_id_idx").on(table.businessId)],
)

// Reference schema for multi-ledger business accounts (deferred while each
// business uses a single `primary_ledger`).
//
// export const businessLedgers = pgTable(
//   "business_ledgers",
//   {
//     businessId: identifier("business_id")
//       .notNull()
//       .references(() => businesses.id, { onDelete: "cascade" }),
//     ledger: identifier("ledger")
//       .notNull()
//       .references(() => ledgers.slug, { onDelete: "restrict", onUpdate: "cascade" }),
//     isDefault: boolean("is_default").default(false).notNull(),
//     payableAccountRef: identifier("payable_account_ref").notNull(),
//     ...createdAt,
//   },
//   (table) => [
//     primaryKey({ columns: [table.businessId, table.ledger] }),
//     uniqueIndex("business_ledgers_payable_account_ref_unique").on(table.payableAccountRef),
//     uniqueIndex("business_ledgers_default_unique")
//       .on(table.businessId)
//       .where(sql`${table.isDefault}`),
//   ],
// )
