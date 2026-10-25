ALTER TABLE "payment_links" RENAME COLUMN "amount_minor" TO "amount";--> statement-breakpoint
ALTER TABLE "payment_links" RENAME COLUMN "suggested_amount_minor" TO "suggested_amount";--> statement-breakpoint
ALTER TABLE "payment_links" RENAME COLUMN "minimum_amount_minor" TO "minimum_amount";--> statement-breakpoint
ALTER TABLE "payment_links" RENAME COLUMN "maximum_amount_minor" TO "maximum_amount";--> statement-breakpoint
ALTER TABLE "payments" RENAME COLUMN "amount_minor" TO "amount";--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT "payments_link_fk";--> statement-breakpoint
ALTER TABLE "payment_links" DROP CONSTRAINT "payment_links_payment_target_unique";--> statement-breakpoint
ALTER TABLE "payment_links" DROP CONSTRAINT "payment_links_currency_code_valid";--> statement-breakpoint
ALTER TABLE "payment_links" DROP CONSTRAINT "payment_links_scale_valid";--> statement-breakpoint
ALTER TABLE "payment_links" DROP CONSTRAINT "payment_links_amount_minor_valid";--> statement-breakpoint
ALTER TABLE "payment_links" DROP CONSTRAINT "payment_links_suggested_amount_minor_valid";--> statement-breakpoint
ALTER TABLE "payment_links" DROP CONSTRAINT "payment_links_minimum_amount_minor_valid";--> statement-breakpoint
ALTER TABLE "payment_links" DROP CONSTRAINT "payment_links_maximum_amount_minor_valid";--> statement-breakpoint
ALTER TABLE "payment_links" DROP CONSTRAINT "payment_links_pricing_settings";--> statement-breakpoint
ALTER TABLE "payment_links" DROP CONSTRAINT "payment_links_minimum_within_maximum";--> statement-breakpoint
ALTER TABLE "payment_links" DROP CONSTRAINT "payment_links_suggested_within_bounds";--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT "payments_amount_minor_valid";--> statement-breakpoint
ALTER TABLE "payment_links" ADD COLUMN "ledger" text NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "ledger" text NOT NULL;--> statement-breakpoint
ALTER TABLE "businesses" ADD CONSTRAINT "businesses_id_primary_ledger_unique" UNIQUE("id","primary_ledger");--> statement-breakpoint
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_payment_target_unique" UNIQUE("id","business_id","ledger");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_id_ledger_unique" UNIQUE("id","ledger");--> statement-breakpoint
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_business_ledger_fk" FOREIGN KEY ("business_id","ledger") REFERENCES "public"."businesses"("id","primary_ledger") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_link_fk" FOREIGN KEY ("link_id","business_id","ledger") REFERENCES "public"."payment_links"("id","business_id","ledger") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "payment_links" DROP COLUMN "currency_code";--> statement-breakpoint
ALTER TABLE "payment_links" DROP COLUMN "scale";--> statement-breakpoint
ALTER TABLE "payments" DROP COLUMN "currency_code";--> statement-breakpoint
ALTER TABLE "payments" DROP COLUMN "scale";--> statement-breakpoint
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_amount_valid" CHECK ("payment_links"."amount" is null or "payment_links"."amount" between 1 and 9007199254740991);--> statement-breakpoint
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_suggested_amount_valid" CHECK ("payment_links"."suggested_amount" is null or "payment_links"."suggested_amount" between 1 and 9007199254740991);--> statement-breakpoint
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_minimum_amount_valid" CHECK ("payment_links"."minimum_amount" is null or "payment_links"."minimum_amount" between 1 and 9007199254740991);--> statement-breakpoint
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_maximum_amount_valid" CHECK ("payment_links"."maximum_amount" is null or "payment_links"."maximum_amount" between 1 and 9007199254740991);--> statement-breakpoint
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_pricing_settings" CHECK (case "payment_links"."pricing_mode"
        when 'fixed' then "payment_links"."amount" is not null
          and "payment_links"."suggested_amount" is null
          and "payment_links"."minimum_amount" is null
          and "payment_links"."maximum_amount" is null
        else "payment_links"."amount" is null
      end);--> statement-breakpoint
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_minimum_within_maximum" CHECK ("payment_links"."minimum_amount" is null or "payment_links"."maximum_amount" is null or "payment_links"."minimum_amount" <= "payment_links"."maximum_amount");--> statement-breakpoint
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_suggested_within_bounds" CHECK ("payment_links"."suggested_amount" is null or (
        ("payment_links"."minimum_amount" is null or "payment_links"."suggested_amount" >= "payment_links"."minimum_amount")
        and ("payment_links"."maximum_amount" is null or "payment_links"."suggested_amount" <= "payment_links"."maximum_amount")
      ));--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_amount_valid" CHECK ("payments"."amount" between 1 and 9007199254740991);