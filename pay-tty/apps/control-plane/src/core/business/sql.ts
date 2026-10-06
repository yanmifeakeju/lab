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

import { createdAt, timestamps } from "../../database/columns.ts"
import { ledgers } from "../ledger/sql.ts"
import { principals } from "../principal/sql.ts"

export const statuses = ["provisioning", "stalled", "active"] as const

export const steps = ["business", "ledger", "workspace"] as const

export const provisioningStatus = pgEnum("business_provisioning_status", statuses)

export const provisioningStep = pgEnum("business_provisioning_step", steps)

export const businesses = pgTable(
  "businesses",
  {
    id: text("id").primaryKey(),
    // Fixed at creation: the ledger holder carries this name and rejects a
    // different one when the business onboards onto another ledger.
    name: text("name").notNull(),
    provisioningStatus: provisioningStatus("provisioning_status")
      .default("provisioning")
      .notNull(),
    provisioningStep: provisioningStep("provisioning_step").default("business").notNull(),
    // One holder across every ledger the business is in.
    ledgerHolderRef: text("ledger_holder_ref"),
    failureCode: text("failure_code"),
    failureMessage: text("failure_message"),
    ...timestamps,
  },
  (table) => [
    index("businesses_provisioning_status_idx").on(table.provisioningStatus),
    check(
      "businesses_failure_check",
      sql`num_nonnulls(${table.failureCode}, ${table.failureMessage}) = case when ${table.provisioningStatus} = 'stalled' then 2 else 0 end`,
    ),
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

// The ledgers a business is in, with its payable account in each. The default
// row is written with the business, so the ledger its sessions run against is
// known before provisioning has an account ref to record.
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
    // Null until the ledger creates the account.
    payableAccountRef: text("payable_account_ref"),
    ...createdAt,
  },
  (table) => [
    primaryKey({ columns: [table.businessId, table.ledger] }),
    uniqueIndex("business_ledgers_payable_account_ref_unique").on(table.payableAccountRef),
    // Uniqueness only: create writes the default row alongside the business,
    // and activation requires its ref, so no business is without one.
    uniqueIndex("business_ledgers_default_unique")
      .on(table.businessId)
      .where(sql`${table.isDefault}`),
    // Only the default ledger is joined before its account exists.
    check(
      "business_ledgers_ref_check",
      sql`${table.isDefault} or ${table.payableAccountRef} is not null`,
    ),
  ],
)
