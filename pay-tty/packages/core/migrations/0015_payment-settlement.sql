ALTER TABLE "ledger_postings" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ledger_postings" ADD COLUMN "settles_at" timestamp with time zone;--> statement-breakpoint
-- Resolutions recorded before this column existed: their last attempt is when.
UPDATE "ledger_postings" SET "resolved_at" = "last_attempt_at" WHERE "resolution_ref" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ledger_postings_settling_idx" ON "ledger_postings" USING btree ("settles_at") WHERE "ledger_postings"."settles_at" is not null and "ledger_postings"."resolution" is null and "ledger_postings"."state" = 'pending';--> statement-breakpoint
ALTER TABLE "ledger_postings" ADD CONSTRAINT "ledger_postings_resolved_with_ref" CHECK (("ledger_postings"."resolution_ref" is null) = ("ledger_postings"."resolved_at" is null));--> statement-breakpoint
ALTER TABLE "ledger_postings" ADD CONSTRAINT "ledger_postings_settles_pending_payments" CHECK ("ledger_postings"."settles_at" is null or ("ledger_postings"."pending" and "ledger_postings"."payment_id" is not null));