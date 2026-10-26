CREATE TYPE "public"."ledger_posting_state" AS ENUM('created', 'pending', 'posted', 'voided', 'expired', 'refused');--> statement-breakpoint
CREATE TABLE "ledger_postings" (
	"id" text PRIMARY KEY NOT NULL,
	"business_id" text NOT NULL,
	"ledger" text NOT NULL,
	"payment_id" text,
	"kind" text NOT NULL,
	"description" text NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"lines" jsonb NOT NULL,
	"state" "ledger_posting_state" DEFAULT 'created' NOT NULL,
	"journal_ref" text,
	"resolution_ref" text,
	"error_code" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recorded_at" timestamp with time zone,
	CONSTRAINT "ledger_postings_one_cause" CHECK (num_nonnulls("ledger_postings"."payment_id") = 1),
	CONSTRAINT "ledger_postings_state_shape" CHECK (("ledger_postings"."state" = 'created'
          and "ledger_postings"."journal_ref" is null and "ledger_postings"."resolution_ref" is null and "ledger_postings"."error_code" is null)
        or ("ledger_postings"."state" = 'pending'
          and "ledger_postings"."journal_ref" is not null and "ledger_postings"."resolution_ref" is null and "ledger_postings"."error_code" is null)
        or ("ledger_postings"."state" = 'posted'
          and "ledger_postings"."journal_ref" is not null and "ledger_postings"."error_code" is null)
        or ("ledger_postings"."state" in ('voided', 'expired')
          and "ledger_postings"."journal_ref" is not null and "ledger_postings"."resolution_ref" is not null and "ledger_postings"."error_code" is null)
        or ("ledger_postings"."state" = 'refused'
          and "ledger_postings"."error_code" is not null and "ledger_postings"."resolution_ref" is null)),
	CONSTRAINT "ledger_postings_recorded_with_journal" CHECK (("ledger_postings"."journal_ref" is null) = ("ledger_postings"."recorded_at" is null))
);
--> statement-breakpoint
ALTER TABLE "ledger_postings" ADD CONSTRAINT "ledger_postings_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_postings" ADD CONSTRAINT "ledger_postings_ledger_ledgers_slug_fk" FOREIGN KEY ("ledger") REFERENCES "public"."ledgers"("slug") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "ledger_postings" ADD CONSTRAINT "ledger_postings_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_postings" ADD CONSTRAINT "ledger_postings_payment_ledger_fk" FOREIGN KEY ("payment_id","ledger") REFERENCES "public"."payments"("id","ledger") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_postings_payment_unique" ON "ledger_postings" USING btree ("payment_id") WHERE "ledger_postings"."payment_id" is not null;--> statement-breakpoint
CREATE INDEX "ledger_postings_created_idx" ON "ledger_postings" USING btree ("created_at") WHERE "ledger_postings"."state" = 'created';