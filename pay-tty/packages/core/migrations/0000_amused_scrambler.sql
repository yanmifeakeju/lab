CREATE TYPE "public"."business_status" AS ENUM('created', 'active');--> statement-breakpoint
CREATE TYPE "public"."platform_account_label" AS ENUM('cash', 'fee');--> statement-breakpoint
CREATE TABLE "business_ledgers" (
	"business_id" text NOT NULL,
	"ledger" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"payable_account_ref" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "business_ledgers_business_id_ledger_pk" PRIMARY KEY("business_id","ledger")
);
--> statement-breakpoint
CREATE TABLE "business_principals" (
	"principal_id" text PRIMARY KEY NOT NULL,
	"business_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "businesses" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"currency_code" text DEFAULT 'NGN' NOT NULL,
	"status" "business_status" DEFAULT 'created' NOT NULL,
	"ledger_holder_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "businesses_currency_code_valid" CHECK ("businesses"."currency_code" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "ledgers" (
	"slug" text PRIMARY KEY NOT NULL,
	"currency" text NOT NULL,
	"scale" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledgers_slug_not_blank" CHECK ("ledgers"."slug" ~ '\S'),
	CONSTRAINT "ledgers_currency_valid" CHECK ("ledgers"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "ledgers_scale_valid" CHECK ("ledgers"."scale" between 0 and 4)
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
ALTER TABLE "business_ledgers" ADD CONSTRAINT "business_ledgers_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_ledgers" ADD CONSTRAINT "business_ledgers_ledger_ledgers_slug_fk" FOREIGN KEY ("ledger") REFERENCES "public"."ledgers"("slug") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "business_principals" ADD CONSTRAINT "business_principals_principal_id_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_principals" ADD CONSTRAINT "business_principals_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_accounts" ADD CONSTRAINT "platform_accounts_ledger_ledgers_slug_fk" FOREIGN KEY ("ledger") REFERENCES "public"."ledgers"("slug") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "business_ledgers_payable_account_ref_unique" ON "business_ledgers" USING btree ("payable_account_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "business_ledgers_default_unique" ON "business_ledgers" USING btree ("business_id") WHERE "business_ledgers"."is_default";--> statement-breakpoint
CREATE INDEX "business_principals_business_id_idx" ON "business_principals" USING btree ("business_id");--> statement-breakpoint
CREATE UNIQUE INDEX "principals_issuer_subject_unique" ON "principals" USING btree ("issuer","subject");