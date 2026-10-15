CREATE TYPE "public"."payment_link_pricing_mode" AS ENUM('fixed', 'customer_chooses');--> statement-breakpoint
CREATE TABLE "payment_links" (
	"id" text PRIMARY KEY NOT NULL,
	"business_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"share_token" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"currency_code" text NOT NULL,
	"scale" smallint NOT NULL,
	"pricing_mode" "payment_link_pricing_mode" NOT NULL,
	"amount_minor" bigint,
	"suggested_amount_minor" bigint,
	"minimum_amount_minor" bigint,
	"maximum_amount_minor" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_links_idempotency_key_valid" CHECK ("payment_links"."idempotency_key" ~ '^[!-~]{1,255}$'),
	CONSTRAINT "payment_links_share_token_valid" CHECK ("payment_links"."share_token" ~ '^[A-Za-z0-9_-]{43}$'),
	CONSTRAINT "payment_links_title_valid" CHECK ("payment_links"."title" <> '' and char_length("payment_links"."title") <= 255 and "payment_links"."title" !~ '^[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]|[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]$'),
	CONSTRAINT "payment_links_description_valid" CHECK ("payment_links"."description" is null or ("payment_links"."description" <> '' and char_length("payment_links"."description") <= 500 and "payment_links"."description" !~ '^[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]|[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]$')),
	CONSTRAINT "payment_links_currency_code_valid" CHECK ("payment_links"."currency_code" ~ '^[A-Z]{3}$'),
	CONSTRAINT "payment_links_scale_valid" CHECK ("payment_links"."scale" between 0 and 4),
	CONSTRAINT "payment_links_pricing_settings" CHECK (case "payment_links"."pricing_mode"
        when 'fixed' then "payment_links"."amount_minor" is not null
          and "payment_links"."suggested_amount_minor" is null
          and "payment_links"."minimum_amount_minor" is null
          and "payment_links"."maximum_amount_minor" is null
        else "payment_links"."amount_minor" is null
      end),
	CONSTRAINT "payment_links_amount_minor_valid" CHECK ("payment_links"."amount_minor" is null or "payment_links"."amount_minor" between 1 and 9007199254740991),
	CONSTRAINT "payment_links_suggested_amount_minor_valid" CHECK ("payment_links"."suggested_amount_minor" is null or "payment_links"."suggested_amount_minor" between 1 and 9007199254740991),
	CONSTRAINT "payment_links_minimum_amount_minor_valid" CHECK ("payment_links"."minimum_amount_minor" is null or "payment_links"."minimum_amount_minor" between 1 and 9007199254740991),
	CONSTRAINT "payment_links_maximum_amount_minor_valid" CHECK ("payment_links"."maximum_amount_minor" is null or "payment_links"."maximum_amount_minor" between 1 and 9007199254740991),
	CONSTRAINT "payment_links_minimum_within_maximum" CHECK ("payment_links"."minimum_amount_minor" is null or "payment_links"."maximum_amount_minor" is null or "payment_links"."minimum_amount_minor" <= "payment_links"."maximum_amount_minor"),
	CONSTRAINT "payment_links_suggested_within_bounds" CHECK ("payment_links"."suggested_amount_minor" is null or (
        ("payment_links"."minimum_amount_minor" is null or "payment_links"."suggested_amount_minor" >= "payment_links"."minimum_amount_minor")
        and ("payment_links"."maximum_amount_minor" is null or "payment_links"."suggested_amount_minor" <= "payment_links"."maximum_amount_minor")
      ))
);
--> statement-breakpoint
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_links_business_id_idempotency_key_unique" ON "payment_links" USING btree ("business_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_links_share_token_unique" ON "payment_links" USING btree ("share_token");