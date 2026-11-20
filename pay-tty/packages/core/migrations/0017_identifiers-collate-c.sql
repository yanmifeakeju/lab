ALTER TABLE "business_principals" ALTER COLUMN "principal_id" SET DATA TYPE text COLLATE "C";--> statement-breakpoint
ALTER TABLE "business_principals" ALTER COLUMN "business_id" SET DATA TYPE text COLLATE "C";--> statement-breakpoint
ALTER TABLE "businesses" ALTER COLUMN "id" SET DATA TYPE text COLLATE "C";--> statement-breakpoint
ALTER TABLE "businesses" ALTER COLUMN "country_code" SET DATA TYPE text COLLATE "C";--> statement-breakpoint
ALTER TABLE "businesses" ALTER COLUMN "country_code" SET DEFAULT 'NG';--> statement-breakpoint
ALTER TABLE "businesses" ALTER COLUMN "currency_code" SET DATA TYPE text COLLATE "C";--> statement-breakpoint
ALTER TABLE "businesses" ALTER COLUMN "primary_ledger" SET DATA TYPE text COLLATE "C";--> statement-breakpoint
ALTER TABLE "businesses" ALTER COLUMN "primary_payable_account_ref" SET DATA TYPE text COLLATE "C";--> statement-breakpoint
ALTER TABLE "businesses" ALTER COLUMN "ledger_holder_ref" SET DATA TYPE text COLLATE "C";--> statement-breakpoint
ALTER TABLE "ledger_postings" ALTER COLUMN "id" SET DATA TYPE text COLLATE "C";--> statement-breakpoint
ALTER TABLE "ledger_postings" ALTER COLUMN "business_id" SET DATA TYPE text COLLATE "C";--> statement-breakpoint
ALTER TABLE "ledger_postings" ALTER COLUMN "ledger" SET DATA TYPE text COLLATE "C";--> statement-breakpoint
ALTER TABLE "ledger_postings" ALTER COLUMN "payment_id" SET DATA TYPE text COLLATE "C";--> statement-breakpoint
ALTER TABLE "ledger_postings" ALTER COLUMN "payout_id" SET DATA TYPE text COLLATE "C";--> statement-breakpoint
ALTER TABLE "ledger_postings" ALTER COLUMN "journal_ref" SET DATA TYPE text COLLATE "C";--> statement-breakpoint
ALTER TABLE "ledger_postings" ALTER COLUMN "resolution_ref" SET DATA TYPE text COLLATE "C";--> statement-breakpoint
ALTER TABLE "ledger_postings" ALTER COLUMN "claim_id" SET DATA TYPE text COLLATE "C";--> statement-breakpoint
ALTER TABLE "ledgers" ALTER COLUMN "slug" SET DATA TYPE text COLLATE "C";--> statement-breakpoint
-- The trigger reads currency, so it can't stay while the column changes: dropped and made again as in 0006.
DROP TRIGGER ledgers_currency_scale_immutable ON ledgers;--> statement-breakpoint
ALTER TABLE "ledgers" ALTER COLUMN "currency" SET DATA TYPE text COLLATE "C";--> statement-breakpoint
CREATE TRIGGER ledgers_currency_scale_immutable
BEFORE UPDATE OF currency, scale ON ledgers
FOR EACH ROW
WHEN (NEW.currency IS DISTINCT FROM OLD.currency OR NEW.scale IS DISTINCT FROM OLD.scale)
EXECUTE FUNCTION ledgers_currency_scale_immutable();--> statement-breakpoint
ALTER TABLE "ledgers" ALTER COLUMN "country_code" SET DATA TYPE text COLLATE "C";--> statement-breakpoint
ALTER TABLE "platform_accounts" ALTER COLUMN "ledger" SET DATA TYPE text COLLATE "C";--> statement-breakpoint
ALTER TABLE "platform_accounts" ALTER COLUMN "ledger_account_ref" SET DATA TYPE text COLLATE "C";--> statement-breakpoint
ALTER TABLE "payment_links" ALTER COLUMN "id" SET DATA TYPE text COLLATE "C";--> statement-breakpoint
ALTER TABLE "payment_links" ALTER COLUMN "business_id" SET DATA TYPE text COLLATE "C";--> statement-breakpoint
ALTER TABLE "payment_links" ALTER COLUMN "idempotency_key" SET DATA TYPE text COLLATE "C";--> statement-breakpoint
ALTER TABLE "payment_links" ALTER COLUMN "share_token" SET DATA TYPE text COLLATE "C";--> statement-breakpoint
ALTER TABLE "payment_links" ALTER COLUMN "ledger" SET DATA TYPE text COLLATE "C";--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "id" SET DATA TYPE text COLLATE "C";--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "business_id" SET DATA TYPE text COLLATE "C";--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "link_id" SET DATA TYPE text COLLATE "C";--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "idempotency_key" SET DATA TYPE text COLLATE "C";--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "ledger" SET DATA TYPE text COLLATE "C";--> statement-breakpoint
ALTER TABLE "payout_settings" ALTER COLUMN "business_id" SET DATA TYPE text COLLATE "C";--> statement-breakpoint
ALTER TABLE "payout_settings" ALTER COLUMN "ledger" SET DATA TYPE text COLLATE "C";--> statement-breakpoint
ALTER TABLE "payout_settings" ALTER COLUMN "bank_code" SET DATA TYPE text COLLATE "C";--> statement-breakpoint
ALTER TABLE "payout_settings" ALTER COLUMN "account_number" SET DATA TYPE text COLLATE "C";--> statement-breakpoint
ALTER TABLE "payouts" ALTER COLUMN "id" SET DATA TYPE text COLLATE "C";--> statement-breakpoint
ALTER TABLE "payouts" ALTER COLUMN "business_id" SET DATA TYPE text COLLATE "C";--> statement-breakpoint
ALTER TABLE "payouts" ALTER COLUMN "ledger" SET DATA TYPE text COLLATE "C";--> statement-breakpoint
ALTER TABLE "payouts" ALTER COLUMN "bank_code" SET DATA TYPE text COLLATE "C";--> statement-breakpoint
ALTER TABLE "payouts" ALTER COLUMN "account_number" SET DATA TYPE text COLLATE "C";--> statement-breakpoint
ALTER TABLE "payouts" ALTER COLUMN "idempotency_key" SET DATA TYPE text COLLATE "C";--> statement-breakpoint
ALTER TABLE "payouts" ALTER COLUMN "provider_ref" SET DATA TYPE text COLLATE "C";--> statement-breakpoint
ALTER TABLE "principals" ALTER COLUMN "id" SET DATA TYPE text COLLATE "C";--> statement-breakpoint
ALTER TABLE "principals" ALTER COLUMN "issuer" SET DATA TYPE text COLLATE "C";--> statement-breakpoint
ALTER TABLE "principals" ALTER COLUMN "subject" SET DATA TYPE text COLLATE "C";