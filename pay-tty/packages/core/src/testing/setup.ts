// node:test global setup for core. Each test file that needs plane's schema
// makes its own database with `withDatabase(schema)`; plane's tests use the
// same schema under their own prefix.

import type { Testing } from "@pay-tty/database/testing"

import { type Database, layerUrl } from "../database/client.ts"

const migrationsFolder = new URL("../../migrations", import.meta.url).pathname

// Seeds Nigeria's default ledger and its shared platform accounts, matching scripts/seed.sh.
const seed = `
  INSERT INTO ledgers (slug, currency, scale, country_code, is_country_default) VALUES
    ('ngn_ng', 'NGN', 2, 'NG', true);
  INSERT INTO platform_accounts (ledger, label, ledger_account_ref) VALUES
    ('ngn_ng', 'cash', 'acct_test_cash'),
    ('ngn_ng', 'fee', 'acct_test_fee'),
    ('ngn_ng', 'receivable', 'acct_test_receivable'),
    ('ngn_ng', 'payouts_clearing', 'acct_test_payouts_clearing');
`

/** Plane's migrations and seed, and its database layer. */
export const planeSchema = { migrations: { migrationsFolder }, seed, layer: layerUrl }

export const schema: Testing.Schema<Database> = { prefix: "pay_tty_t_core_", ...planeSchema }

export { globalSetup } from "@pay-tty/database/testing"
