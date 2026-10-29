ALTER TABLE "ledger_postings" ADD COLUMN "claim_id" text;--> statement-breakpoint
ALTER TABLE "ledger_postings" ADD COLUMN "claimed_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ledger_postings" ADD CONSTRAINT "ledger_postings_claimed_together" CHECK (("ledger_postings"."claim_id" is null) = ("ledger_postings"."claimed_until" is null));