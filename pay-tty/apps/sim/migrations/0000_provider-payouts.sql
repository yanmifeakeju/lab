CREATE TYPE "public"."payout_outcome" AS ENUM('paid', 'failed');--> statement-breakpoint
CREATE TABLE "provider_payouts" (
	"provider_ref" text PRIMARY KEY NOT NULL,
	"reference" text NOT NULL,
	"ledger" text NOT NULL,
	"amount" bigint NOT NULL,
	"bank_code" text NOT NULL,
	"account_number" text NOT NULL,
	"account_name" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"outcome" "payout_outcome",
	"reversed_at" timestamp with time zone,
	"reported_at" timestamp with time zone,
	"callback_attempts" integer DEFAULT 0 NOT NULL,
	"next_callback_at" timestamp with time zone,
	"callback_status" smallint,
	"callback_abandoned_at" timestamp with time zone,
	CONSTRAINT "provider_payouts_reference_unique" UNIQUE("reference"),
	CONSTRAINT "provider_payouts_amount_valid" CHECK ("provider_payouts"."amount" between 1 and 9007199254740991),
	CONSTRAINT "provider_payouts_reported_or_abandoned" CHECK ("provider_payouts"."reported_at" is null or "provider_payouts"."callback_abandoned_at" is null),
	CONSTRAINT "provider_payouts_reported_final" CHECK ("provider_payouts"."reported_at" is null or "provider_payouts"."outcome" is not null),
	CONSTRAINT "provider_payouts_reversed_paid" CHECK ("provider_payouts"."reversed_at" is null or "provider_payouts"."outcome" = 'paid')
);
--> statement-breakpoint
CREATE INDEX "provider_payouts_processing_idx" ON "provider_payouts" USING btree ("sent_at") WHERE "provider_payouts"."outcome" is null;--> statement-breakpoint
CREATE INDEX "provider_payouts_unreported_idx" ON "provider_payouts" USING btree ("sent_at") WHERE "provider_payouts"."outcome" is not null and "provider_payouts"."reported_at" is null and "provider_payouts"."callback_abandoned_at" is null;