-- Assumes an empty payouts table: it adds checks without backfilling
-- send_attempted_at or resolution. Pre-launch, migrations are rewritten and
-- databases rebuilt, never migrated in place.
ALTER TABLE "payouts" DROP CONSTRAINT "payouts_completed_with_status";--> statement-breakpoint
DROP INDEX "payouts_one_in_flight";--> statement-breakpoint
ALTER TABLE "payouts" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "payouts" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."payout_status";--> statement-breakpoint
CREATE TYPE "public"."payout_status" AS ENUM('created', 'requested', 'held', 'sent', 'paid', 'failed', 'rejected', 'cancelled', 'expired', 'attention');--> statement-breakpoint
ALTER TABLE "payouts" ALTER COLUMN "status" SET DATA TYPE "public"."payout_status" USING "status"::"public"."payout_status";--> statement-breakpoint
ALTER TABLE "payouts" ALTER COLUMN "status" SET DEFAULT 'created';--> statement-breakpoint
CREATE TYPE "public"."ledger_posting_resolution" AS ENUM('capture', 'void');--> statement-breakpoint
ALTER TABLE "ledger_postings" ADD COLUMN "resolution" "ledger_posting_resolution";--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "send_attempted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "settle_attempted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "ledger_postings_resolving_idx" ON "ledger_postings" USING btree ("created_at") WHERE "ledger_postings"."state" = 'pending' and "ledger_postings"."resolution" is not null;--> statement-breakpoint
CREATE INDEX "ledger_postings_mismatched_idx" ON "ledger_postings" USING btree ("business_id","ledger") WHERE ("ledger_postings"."resolution" is not null and ("ledger_postings"."state" = 'refused'
    or ("ledger_postings"."resolution" = 'capture' and "ledger_postings"."state" = 'voided')
    or ("ledger_postings"."resolution" = 'void' and "ledger_postings"."state" = 'posted')));--> statement-breakpoint
CREATE INDEX "payouts_held_idx" ON "payouts" USING btree ("created_at") WHERE "payouts"."status" = 'held';--> statement-breakpoint
CREATE INDEX "payouts_unanswered_idx" ON "payouts" USING btree ("send_attempted_at") WHERE "payouts"."status" = 'sent' and "payouts"."provider_ref" is null;--> statement-breakpoint
CREATE INDEX "payouts_sent_idx" ON "payouts" USING btree ("sent_at") WHERE "payouts"."status" = 'sent';--> statement-breakpoint
ALTER TABLE "ledger_postings" ADD CONSTRAINT "ledger_postings_resolution_shape" CHECK (("ledger_postings"."resolution" is null or ("ledger_postings"."pending" and "ledger_postings"."state" <> 'created'))
        and (not "ledger_postings"."pending" or "ledger_postings"."state" not in ('posted', 'voided') or "ledger_postings"."resolution" is not null));--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_sent_with_status" CHECK (("payouts"."status" in ('created', 'requested', 'held', 'rejected', 'cancelled', 'expired')
          and "payouts"."sent_at" is null and "payouts"."provider_ref" is null)
        or ("payouts"."status" in ('sent', 'paid') and "payouts"."sent_at" is not null)
        or "payouts"."status" in ('failed', 'attention'));--> statement-breakpoint
ALTER TABLE "ledger_postings" ADD COLUMN "first_attempt_at" timestamp with time zone;--> statement-breakpoint
UPDATE "ledger_postings" SET "first_attempt_at" = coalesce("last_attempt_at", "created_at") WHERE "attempts" > 0;--> statement-breakpoint
ALTER TABLE "ledger_postings" ADD CONSTRAINT "ledger_postings_first_attempt_with_attempts" CHECK (("ledger_postings"."attempts" = 0) = ("ledger_postings"."first_attempt_at" is null));--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_created_expires" CHECK ("payouts"."status" <> 'created' or "payouts"."expires_at" is not null);--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_send_attempted_with_sent" CHECK (("payouts"."sent_at" is null) = ("payouts"."send_attempted_at" is null));--> statement-breakpoint
DROP INDEX "payouts_business_id_trigger_idempotency_key_unique";--> statement-breakpoint
ALTER TABLE "payouts" ALTER COLUMN "idempotency_key" DROP NOT NULL;--> statement-breakpoint
CREATE INDEX "payouts_created_idx" ON "payouts" USING btree ("expires_at") WHERE "payouts"."status" = 'created';--> statement-breakpoint
CREATE UNIQUE INDEX "payouts_business_id_trigger_idempotency_key_unique" ON "payouts" USING btree ("business_id","trigger","idempotency_key") WHERE "payouts"."idempotency_key" is not null;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_completed_with_status" CHECK (("payouts"."status" in ('paid', 'failed', 'rejected', 'cancelled', 'expired')) = ("payouts"."completed_at" is not null));--> statement-breakpoint
DROP INDEX "payouts_business_id_created_at_id_idx";--> statement-breakpoint
CREATE INDEX "payouts_listed_idx" ON "payouts" USING btree ("business_id","created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST) WHERE "payouts"."status" not in ('created', 'expired', 'cancelled');--> statement-breakpoint
CREATE INDEX "payouts_open_drafts_idx" ON "payouts" USING btree ("business_id","ledger","expires_at") WHERE "payouts"."status" = 'created';
