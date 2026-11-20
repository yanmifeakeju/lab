ALTER TABLE "provider_payouts" ALTER COLUMN "provider_ref" SET DATA TYPE text COLLATE "C";--> statement-breakpoint
ALTER TABLE "provider_payouts" ALTER COLUMN "reference" SET DATA TYPE text COLLATE "C";--> statement-breakpoint
ALTER TABLE "provider_payouts" ALTER COLUMN "ledger" SET DATA TYPE text COLLATE "C";--> statement-breakpoint
ALTER TABLE "provider_payouts" ALTER COLUMN "bank_code" SET DATA TYPE text COLLATE "C";--> statement-breakpoint
ALTER TABLE "provider_payouts" ALTER COLUMN "account_number" SET DATA TYPE text COLLATE "C";