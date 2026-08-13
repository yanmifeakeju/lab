-- +goose Up
CREATE TABLE "holders" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "holders_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "holders_external_id_unique" UNIQUE("external_id"),
	CONSTRAINT "holders_name_not_blank" CHECK (length(btrim("holders"."name")) > 0)
);

CREATE TABLE "accounts" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "accounts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"ledger_id" integer NOT NULL,
	"kind" text NOT NULL,
	"channel" text,
	"holder_id" bigint,
	"description" text,
	"debits_pending" bigint DEFAULT 0 NOT NULL,
	"credits_pending" bigint DEFAULT 0 NOT NULL,
	"debits_posted" bigint DEFAULT 0 NOT NULL,
	"credits_posted" bigint DEFAULT 0 NOT NULL,
	"debits_must_not_exceed_credits" boolean DEFAULT false NOT NULL,
	"credits_must_not_exceed_debits" boolean DEFAULT false NOT NULL,
	"is_closed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_kind_valid" CHECK ("accounts"."kind" in ('payable', 'receivable', 'treasury', 'fee_revenue')),
	CONSTRAINT "accounts_kind_matches_holder" CHECK (("accounts"."kind" = 'payable') = ("accounts"."holder_id" is not null)),
	CONSTRAINT "accounts_channel_matches_kind" CHECK (("accounts"."kind" = 'receivable') = ("accounts"."channel" is not null)),
	CONSTRAINT "accounts_flags_exclusive" CHECK (not ("accounts"."debits_must_not_exceed_credits" and "accounts"."credits_must_not_exceed_debits")),
	CONSTRAINT "accounts_counters_non_negative" CHECK ("accounts"."debits_pending" >= 0 and "accounts"."credits_pending" >= 0
           and "accounts"."debits_posted" >= 0 and "accounts"."credits_posted" >= 0),
	CONSTRAINT "accounts_debits_must_not_exceed_credits" CHECK (not "accounts"."debits_must_not_exceed_credits"
           or "accounts"."debits_pending" + "accounts"."debits_posted" <= "accounts"."credits_posted"),
	CONSTRAINT "accounts_credits_must_not_exceed_debits" CHECK (not "accounts"."credits_must_not_exceed_debits"
           or "accounts"."credits_pending" + "accounts"."credits_posted" <= "accounts"."debits_posted")
);

ALTER TABLE "accounts" ADD CONSTRAINT "accounts_ledger_id_ledgers_id_fk" FOREIGN KEY ("ledger_id") REFERENCES "public"."ledgers"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_holder_id_holders_id_fk" FOREIGN KEY ("holder_id") REFERENCES "public"."holders"("id") ON DELETE no action ON UPDATE no action;

CREATE INDEX "accounts_ledger_idx" ON "accounts" USING btree ("ledger_id");
CREATE UNIQUE INDEX "accounts_holder_kind_key" ON "accounts" USING btree ("holder_id","ledger_id","kind") WHERE holder_id is not null;
CREATE UNIQUE INDEX "accounts_platform_kind_key" ON "accounts" USING btree ("ledger_id","kind",COALESCE("channel", '')) WHERE holder_id is null;