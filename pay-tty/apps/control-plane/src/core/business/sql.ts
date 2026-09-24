import { sql } from "drizzle-orm"
import {
  check,
  index,
  pgEnum,
  pgTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core"

import { createdAt, timestamps } from "../../database/columns.ts"
import { ledgers, platformAccountLabel } from "../ledger/sql.ts"
import { principals } from "../principal/sql.ts"

export const statuses = ["provisioning", "stalled", "active"] as const

export const steps = ["business", "ledger", "workspace"] as const

export const provisioningStatus = pgEnum("business_provisioning_status", statuses)

export const provisioningStep = pgEnum("business_provisioning_step", steps)

export const kinds = ["payable", "platform"] as const

export const ledgerAccountKind = pgEnum("ledger_account_kind", kinds)

export const businesses = pgTable(
  "businesses",
  {
    id: text("id").primaryKey(),
    // Fixed at creation: the ledger holder carries this name and rejects a
    // different one when the business onboards onto another ledger.
    name: text("name").notNull(),
    // The ledger the business was registered into, and the one its sessions
    // run against.
    defaultLedger: text("default_ledger")
      .notNull()
      .references(() => ledgers.slug, { onDelete: "restrict", onUpdate: "cascade" }),
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

// The business's accounts in each ledger: its payable account, and any
// platform account overriding that ledger's default for a label.
export const businessLedgerAccounts = pgTable(
  "business_ledger_accounts",
  {
    businessId: text("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    ledger: text("ledger")
      .notNull()
      .references(() => ledgers.slug, { onDelete: "restrict", onUpdate: "cascade" }),
    kind: ledgerAccountKind("kind").notNull(),
    label: platformAccountLabel("label"),
    ledgerAccountRef: text("ledger_account_ref").notNull(),
    ...createdAt,
  },
  (table) => [
    unique("business_ledger_accounts_unique")
      .on(table.businessId, table.ledger, table.kind, table.label)
      .nullsNotDistinct(),
    // A payable account belongs to one business; a platform override may be
    // shared by several.
    uniqueIndex("business_ledger_accounts_payable_ref_unique")
      .on(table.ledgerAccountRef)
      .where(sql`${table.kind} = 'payable'`),
    check(
      "business_ledger_accounts_kind_matches_label",
      sql`(${table.kind} = 'platform') = (${table.label} is not null)`,
    ),
  ],
)
