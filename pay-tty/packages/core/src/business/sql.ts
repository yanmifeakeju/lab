import { sql } from "drizzle-orm"
import {
  check,
  foreignKey,
  index,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core"

import { createdAt, timestamps } from "../database/columns.ts"
import { ledgers } from "../ledger/sql.ts"
import { principals } from "../principal/sql.ts"

export const statuses = ["created", "active"] as const

export const status = pgEnum("business_status", statuses)

// The countries a business can be created in, and the currency each trades
// in. The checks on businesses spell out the same pairs.
export const currencies = { NG: "NGN", US: "USD" } as const

export const countries = ["NG", "US"] as const satisfies ReadonlyArray<keyof typeof currencies>

// Exactly what JavaScript's String.prototype.trim() removes, so a name core
// accepts is one the database accepts. Postgres's own \s differs by locale.
const space = String.raw`[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]`

export const businesses = pgTable(
  "businesses",
  {
    id: text("id").primaryKey(),
    // Fixed at creation: the ledger holder carries this name and rejects a
    // different one when the business onboards onto another ledger.
    name: text("name").notNull(),
    countryCode: text("country_code").default("NG").notNull(),
    // Derived from the country by the server, never the caller's.
    currencyCode: text("currency_code").notNull(),
    // The country's default ledger when the business was created; kept even
    // if that default moves.
    primaryLedger: text("primary_ledger").notNull(),
    // Recorded together once the ledger has created the account.
    primaryPayableAccountRef: text("primary_payable_account_ref"),
    ledgerHolderRef: text("ledger_holder_ref"),
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
    // Through the currency too, so the primary ledger is always in the
    // business's currency.
    foreignKey({
      name: "businesses_primary_ledger_fk",
      columns: [table.primaryLedger, table.currencyCode],
      foreignColumns: [ledgers.slug, ledgers.currency],
    })
      .onDelete("restrict")
      .onUpdate("cascade"),
    uniqueIndex("businesses_primary_payable_account_ref_unique").on(table.primaryPayableAccountRef),
  ],
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

// Deferred until a business needs accounts beyond its primary one, which
// now lives on businesses. Kept as reference for that design; not a table.
//
// export const businessLedgers = pgTable(
//   "business_ledgers",
//   {
//     businessId: text("business_id")
//       .notNull()
//       .references(() => businesses.id, { onDelete: "cascade" }),
//     ledger: text("ledger")
//       .notNull()
//       .references(() => ledgers.slug, { onDelete: "restrict", onUpdate: "cascade" }),
//     isDefault: boolean("is_default").default(false).notNull(),
//     payableAccountRef: text("payable_account_ref").notNull(),
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
