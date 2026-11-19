-- Assumes no sent or paid payouts: it adds checks without backfilling next_check_at or provider_ref.
-- Pre-launch, migrations are rewritten and databases rebuilt, never migrated in place.
DROP INDEX "payouts_sent_idx";--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "next_check_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "check_failing_since" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "payouts_due_idx" ON "payouts" USING btree ("next_check_at") WHERE "payouts"."status" = 'sent';--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_paid_has_ref" CHECK ("payouts"."status" <> 'paid' or ("payouts"."provider_ref" is not null and "payouts"."provider_ref" ~ '\S'));--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_sent_has_next_check" CHECK ("payouts"."status" <> 'sent' or "payouts"."next_check_at" is not null);--> statement-breakpoint
ALTER TABLE "payouts" DROP CONSTRAINT "payouts_send_attempted_with_sent";--> statement-breakpoint
DROP INDEX "payouts_unanswered_idx";--> statement-breakpoint
ALTER TABLE "payouts" DROP COLUMN "send_attempted_at";