CREATE TYPE "public"."payment_status" AS ENUM('pending', 'succeeded', 'failed', 'cancelled', 'expired');--> statement-breakpoint
CREATE TABLE "payments" (
	"id" text PRIMARY KEY NOT NULL,
	"business_id" text NOT NULL,
	"link_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency_code" text NOT NULL,
	"scale" smallint NOT NULL,
	"status" "payment_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "payments_idempotency_key_valid" CHECK ("payments"."idempotency_key" ~ '^[!-~]{1,255}$'),
	CONSTRAINT "payments_amount_minor_valid" CHECK ("payments"."amount_minor" between 1 and 9007199254740991),
	CONSTRAINT "payments_expires_after_created" CHECK ("payments"."expires_at" > "payments"."created_at"),
	CONSTRAINT "payments_completed_with_status" CHECK (("payments"."status" = 'pending') = ("payments"."completed_at" is null))
);
--> statement-breakpoint
ALTER TABLE "payment_links" DROP CONSTRAINT "payment_links_share_token_valid";--> statement-breakpoint
ALTER TABLE "payment_links" ADD COLUMN "deactivated_at" timestamp with time zone;--> statement-breakpoint
-- Before payments_link_fk, which needs it.
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_payment_target_unique" UNIQUE("id","business_id","currency_code","scale");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_link_fk" FOREIGN KEY ("link_id","business_id","currency_code","scale") REFERENCES "public"."payment_links"("id","business_id","currency_code","scale") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payments_link_id_idempotency_key_unique" ON "payments" USING btree ("link_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "payments_link_id_created_at_idx" ON "payments" USING btree ("link_id","created_at");--> statement-breakpoint
CREATE INDEX "payments_pending_expires_at_idx" ON "payments" USING btree ("expires_at") WHERE "payments"."status" = 'pending';--> statement-breakpoint
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_share_token_valid" CHECK ("payment_links"."share_token" ~ '^[A-Za-z0-9_][A-Za-z0-9_-]{42}$');