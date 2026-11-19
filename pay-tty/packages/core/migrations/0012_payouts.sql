CREATE TYPE "public"."payout_mode" AS ENUM('manual', 'automatic');--> statement-breakpoint
CREATE TYPE "public"."payout_status" AS ENUM('requested', 'held', 'sent', 'paid', 'failed', 'rejected', 'attention');--> statement-breakpoint
CREATE TYPE "public"."payout_trigger" AS ENUM('manual', 'scheduled');--> statement-breakpoint
ALTER TYPE "public"."platform_account_label" ADD VALUE 'receivable';--> statement-breakpoint
ALTER TYPE "public"."platform_account_label" ADD VALUE 'payouts_clearing';--> statement-breakpoint
CREATE TABLE "payout_settings" (
	"business_id" text NOT NULL,
	"ledger" text NOT NULL,
	"mode" "payout_mode" DEFAULT 'manual' NOT NULL,
	"bank_code" text NOT NULL,
	"account_number" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payout_settings_business_id_ledger_pk" PRIMARY KEY("business_id","ledger"),
	CONSTRAINT "payout_settings_bank_code_valid" CHECK ("payout_settings"."bank_code" ~ '^[0-9]{3}$'),
	CONSTRAINT "payout_settings_account_number_valid" CHECK ("payout_settings"."account_number" ~ '^[0-9]{10}$')
);
--> statement-breakpoint
CREATE TABLE "payouts" (
	"id" text PRIMARY KEY NOT NULL,
	"business_id" text NOT NULL,
	"ledger" text NOT NULL,
	"amount" bigint NOT NULL,
	"trigger" "payout_trigger" NOT NULL,
	"scheduled_for" date,
	"bank_code" text NOT NULL,
	"account_number" text NOT NULL,
	"account_name" text NOT NULL,
	"status" "payout_status" DEFAULT 'requested' NOT NULL,
	"idempotency_key" text NOT NULL,
	"provider_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "payouts_id_ledger_unique" UNIQUE("id","ledger"),
	CONSTRAINT "payouts_idempotency_key_valid" CHECK ("payouts"."idempotency_key" ~ '^[!-~]{1,255}$'),
	CONSTRAINT "payouts_amount_valid" CHECK ("payouts"."amount" between 1 and 9007199254740991),
	CONSTRAINT "payouts_scheduled_has_date" CHECK (("payouts"."trigger" = 'scheduled') = ("payouts"."scheduled_for" is not null)),
	CONSTRAINT "payouts_bank_code_valid" CHECK ("payouts"."bank_code" ~ '^[0-9]{3}$'),
	CONSTRAINT "payouts_account_number_valid" CHECK ("payouts"."account_number" ~ '^[0-9]{10}$'),
	CONSTRAINT "payouts_account_name_valid" CHECK ("payouts"."account_name" <> '' and "payouts"."account_name" !~ '^[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]|[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]$'),
	CONSTRAINT "payouts_completed_with_status" CHECK (("payouts"."status" in ('paid', 'failed', 'rejected')) = ("payouts"."completed_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "ledger_postings" DROP CONSTRAINT "ledger_postings_one_cause";--> statement-breakpoint
ALTER TABLE "ledger_postings" DROP CONSTRAINT "ledger_postings_state_shape";--> statement-breakpoint
-- The partial index compares state with the old enum, so it can't survive the
-- column passing through text; it is rebuilt once the new type is in place.
DROP INDEX "ledger_postings_created_idx";--> statement-breakpoint
ALTER TABLE "ledger_postings" ALTER COLUMN "state" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "ledger_postings" ALTER COLUMN "state" SET DEFAULT 'created'::text;--> statement-breakpoint
DROP TYPE "public"."ledger_posting_state";--> statement-breakpoint
CREATE TYPE "public"."ledger_posting_state" AS ENUM('created', 'pending', 'posted', 'voided', 'refused');--> statement-breakpoint
ALTER TABLE "ledger_postings" ALTER COLUMN "state" SET DEFAULT 'created'::"public"."ledger_posting_state";--> statement-breakpoint
ALTER TABLE "ledger_postings" ALTER COLUMN "state" SET DATA TYPE "public"."ledger_posting_state" USING "state"::"public"."ledger_posting_state";--> statement-breakpoint
CREATE INDEX "ledger_postings_created_idx" ON "ledger_postings" USING btree ("created_at") WHERE "ledger_postings"."state" = 'created';--> statement-breakpoint
ALTER TABLE "ledger_postings" ADD COLUMN "payout_id" text;--> statement-breakpoint
ALTER TABLE "ledger_postings" ADD COLUMN "pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "payout_settings" ADD CONSTRAINT "payout_settings_business_ledger_fk" FOREIGN KEY ("business_id","ledger") REFERENCES "public"."businesses"("id","primary_ledger") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_settings_fk" FOREIGN KEY ("business_id","ledger") REFERENCES "public"."payout_settings"("business_id","ledger") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "payouts_business_id_trigger_idempotency_key_unique" ON "payouts" USING btree ("business_id","trigger","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "payouts_scheduled_unique" ON "payouts" USING btree ("business_id","ledger","scheduled_for") WHERE "payouts"."scheduled_for" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "payouts_one_in_flight" ON "payouts" USING btree ("business_id","ledger") WHERE "payouts"."status" in ('requested', 'held', 'sent', 'attention');--> statement-breakpoint
CREATE INDEX "payouts_business_id_created_at_id_idx" ON "payouts" USING btree ("business_id","created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
ALTER TABLE "ledger_postings" ADD CONSTRAINT "ledger_postings_payout_id_payouts_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."payouts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_postings" ADD CONSTRAINT "ledger_postings_payout_ledger_fk" FOREIGN KEY ("payout_id","ledger") REFERENCES "public"."payouts"("id","ledger") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_postings_payout_unique" ON "ledger_postings" USING btree ("payout_id") WHERE "ledger_postings"."payout_id" is not null;--> statement-breakpoint
ALTER TABLE "ledger_postings" ADD CONSTRAINT "ledger_postings_pending_states" CHECK ("ledger_postings"."state" not in ('pending', 'voided') or "ledger_postings"."pending");--> statement-breakpoint
ALTER TABLE "ledger_postings" ADD CONSTRAINT "ledger_postings_one_cause" CHECK (num_nonnulls("ledger_postings"."payment_id", "ledger_postings"."payout_id") = 1);--> statement-breakpoint
ALTER TABLE "ledger_postings" ADD CONSTRAINT "ledger_postings_state_shape" CHECK (("ledger_postings"."state" = 'created'
          and "ledger_postings"."journal_ref" is null and "ledger_postings"."resolution_ref" is null and "ledger_postings"."error_code" is null)
        or ("ledger_postings"."state" = 'pending'
          and "ledger_postings"."journal_ref" is not null and "ledger_postings"."resolution_ref" is null and "ledger_postings"."error_code" is null)
        or ("ledger_postings"."state" = 'posted'
          and "ledger_postings"."journal_ref" is not null and "ledger_postings"."error_code" is null
          and ("ledger_postings"."resolution_ref" is not null) = "ledger_postings"."pending")
        or ("ledger_postings"."state" = 'voided'
          and "ledger_postings"."journal_ref" is not null and "ledger_postings"."resolution_ref" is not null and "ledger_postings"."error_code" is null)
        or ("ledger_postings"."state" = 'refused'
          and "ledger_postings"."error_code" is not null and "ledger_postings"."resolution_ref" is null));