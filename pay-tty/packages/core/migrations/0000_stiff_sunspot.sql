CREATE TYPE "public"."business_status" AS ENUM('created', 'active');--> statement-breakpoint
CREATE TYPE "public"."platform_account_label" AS ENUM('cash', 'fee');--> statement-breakpoint
CREATE TABLE "business_principals" (
	"principal_id" text PRIMARY KEY NOT NULL,
	"business_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "businesses" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"country_code" text DEFAULT 'NG' NOT NULL,
	"currency_code" text NOT NULL,
	"primary_ledger" text NOT NULL,
	"primary_payable_account_ref" text,
	"ledger_holder_ref" text,
	"status" "business_status" DEFAULT 'created' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "businesses_country_code_valid" CHECK ("businesses"."country_code" in ('NG', 'US')),
	CONSTRAINT "businesses_currency_code_matches_country" CHECK (("businesses"."country_code", "businesses"."currency_code") in (('NG', 'NGN'), ('US', 'USD'))),
	CONSTRAINT "businesses_holder_with_account" CHECK (("businesses"."ledger_holder_ref" is null) = ("businesses"."primary_payable_account_ref" is null)),
	CONSTRAINT "businesses_active_has_account" CHECK ("businesses"."status" <> 'active' or "businesses"."primary_payable_account_ref" is not null)
);
--> statement-breakpoint
CREATE TABLE "ledgers" (
	"slug" text PRIMARY KEY NOT NULL,
	"currency" text NOT NULL,
	"scale" smallint NOT NULL,
	"country_code" text,
	"is_country_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledgers_slug_currency_unique" UNIQUE("slug","currency"),
	CONSTRAINT "ledgers_slug_not_blank" CHECK ("ledgers"."slug" ~ '\S'),
	CONSTRAINT "ledgers_currency_valid" CHECK ("ledgers"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "ledgers_scale_valid" CHECK ("ledgers"."scale" between 0 and 4),
	CONSTRAINT "ledgers_country_code_valid" CHECK ("ledgers"."country_code" ~ '^[A-Z]{2}$'),
	CONSTRAINT "ledgers_country_default_has_country" CHECK (not "ledgers"."is_country_default" or "ledgers"."country_code" is not null)
);
--> statement-breakpoint
CREATE TABLE "platform_accounts" (
	"ledger" text NOT NULL,
	"label" "platform_account_label" NOT NULL,
	"ledger_account_ref" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_accounts_ledger_label_pk" PRIMARY KEY("ledger","label")
);
--> statement-breakpoint
CREATE TABLE "principals" (
	"id" text PRIMARY KEY NOT NULL,
	"issuer" text NOT NULL,
	"subject" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "business_principals" ADD CONSTRAINT "business_principals_principal_id_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_principals" ADD CONSTRAINT "business_principals_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "businesses" ADD CONSTRAINT "businesses_primary_ledger_fk" FOREIGN KEY ("primary_ledger","currency_code") REFERENCES "public"."ledgers"("slug","currency") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "platform_accounts" ADD CONSTRAINT "platform_accounts_ledger_ledgers_slug_fk" FOREIGN KEY ("ledger") REFERENCES "public"."ledgers"("slug") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "business_principals_business_id_idx" ON "business_principals" USING btree ("business_id");--> statement-breakpoint
CREATE UNIQUE INDEX "businesses_primary_payable_account_ref_unique" ON "businesses" USING btree ("primary_payable_account_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "ledgers_country_default_unique" ON "ledgers" USING btree ("country_code") WHERE "ledgers"."is_country_default";--> statement-breakpoint
CREATE UNIQUE INDEX "principals_issuer_subject_unique" ON "principals" USING btree ("issuer","subject");