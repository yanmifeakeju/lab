-- +goose Up
CREATE TABLE "holders" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "holders_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"public_ref" text COLLATE "C" NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "holders_public_ref_unique" UNIQUE("public_ref"),
	CONSTRAINT "holders_public_ref_valid" CHECK ("holders"."public_ref" ~ '^hld_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
	CONSTRAINT "holders_external_id_unique" UNIQUE("external_id"),
	CONSTRAINT "holders_name_not_blank" CHECK ("holders"."name" ~ '\S')
);

CREATE TABLE "accounts" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "accounts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"public_ref" text COLLATE "C" NOT NULL,
	"ledger_id" integer NOT NULL,
	"kind" text NOT NULL,
	"label" text,
	"holder_id" bigint,
	"description" text,
	"debits_pending" bigint DEFAULT 0 NOT NULL,
	"credits_pending" bigint DEFAULT 0 NOT NULL,
	"debits_posted" bigint DEFAULT 0 NOT NULL,
	"credits_posted" bigint DEFAULT 0 NOT NULL,
	"movement_count" bigint DEFAULT 0 NOT NULL,
	"debits_must_not_exceed_credits" boolean DEFAULT false NOT NULL,
	"credits_must_not_exceed_debits" boolean DEFAULT false NOT NULL,
	"records_movements" boolean DEFAULT false NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_public_ref_unique" UNIQUE("public_ref"),
	CONSTRAINT "accounts_public_ref_valid" CHECK ("accounts"."public_ref" ~ '^acct_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
	CONSTRAINT "accounts_kind_valid" CHECK ("accounts"."kind" in ('payable', 'platform')),
	CONSTRAINT "accounts_kind_matches_holder" CHECK (("accounts"."kind" = 'payable') = ("accounts"."holder_id" is not null)),
	CONSTRAINT "accounts_kind_matches_label" CHECK (("accounts"."kind" = 'platform') = ("accounts"."label" IS NOT NULL)),
	CONSTRAINT "accounts_label_valid" CHECK ("accounts"."label" IS NULL OR ("accounts"."label" ~ '\S' AND length("accounts"."label") <= 64)),
	CONSTRAINT "accounts_payable_records_movements" CHECK ("accounts"."kind" <> 'payable' OR "accounts"."records_movements"),
	-- TODO: Decide the payable negative-balance policy before enabling this.
	-- Chargebacks may need to debit a merchant beyond their posted credits.
	-- CONSTRAINT "accounts_payable_debits_restricted" CHECK ("accounts"."kind" <> 'payable' or "accounts"."debits_must_not_exceed_credits"),
	CONSTRAINT "accounts_flags_exclusive" CHECK (not ("accounts"."debits_must_not_exceed_credits" and "accounts"."credits_must_not_exceed_debits")),
	CONSTRAINT "accounts_counters_non_negative" CHECK ("accounts"."debits_pending" >= 0 and "accounts"."credits_pending" >= 0
           and "accounts"."debits_posted" >= 0 and "accounts"."credits_posted" >= 0),
	CONSTRAINT "accounts_debits_must_not_exceed_credits" CHECK (not "accounts"."debits_must_not_exceed_credits"
           or "accounts"."debits_pending" + "accounts"."debits_posted" <= "accounts"."credits_posted"),
	CONSTRAINT "accounts_credits_must_not_exceed_debits" CHECK (not "accounts"."credits_must_not_exceed_debits"
           or "accounts"."credits_pending" + "accounts"."credits_posted" <= "accounts"."debits_posted"),
	CONSTRAINT "accounts_untracked_counters_zero" CHECK (
		("accounts"."debits_must_not_exceed_credits" OR "accounts"."credits_must_not_exceed_debits" OR "accounts"."records_movements")
		OR (
			"accounts"."debits_pending" = 0 AND "accounts"."credits_pending" = 0
			AND "accounts"."debits_posted" = 0 AND "accounts"."credits_posted" = 0
			AND "accounts"."movement_count" = 0
		)
	)
);

ALTER TABLE "accounts" ADD CONSTRAINT "accounts_ledger_id_ledgers_id_fk" FOREIGN KEY ("ledger_id") REFERENCES "public"."ledgers"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_holder_id_holders_id_fk" FOREIGN KEY ("holder_id") REFERENCES "public"."holders"("id") ON DELETE no action ON UPDATE no action;

CREATE INDEX "accounts_ledger_idx" ON "accounts" USING btree ("ledger_id");
CREATE UNIQUE INDEX "accounts_holder_kind_key" ON "accounts" USING btree ("holder_id","ledger_id","kind") WHERE holder_id is not null;

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION accounts_before_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.closed_at IS NOT NULL THEN
    NEW.closed_at := greatest(NEW.closed_at, clock_timestamp());
  END IF;

  RETURN NEW;
END;
$$;
-- +goose StatementEnd

CREATE TRIGGER accounts_before_insert
BEFORE INSERT ON accounts
FOR EACH ROW
EXECUTE FUNCTION accounts_before_insert();

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION accounts_before_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.records_movements IS DISTINCT FROM OLD.records_movements THEN
    RAISE EXCEPTION 'records_movements is immutable';
  END IF;

  IF NEW.debits_must_not_exceed_credits IS DISTINCT FROM OLD.debits_must_not_exceed_credits THEN
    RAISE EXCEPTION 'debits_must_not_exceed_credits is immutable';
  END IF;

  IF NEW.credits_must_not_exceed_debits IS DISTINCT FROM OLD.credits_must_not_exceed_debits THEN
    RAISE EXCEPTION 'credits_must_not_exceed_debits is immutable';
  END IF;

  IF OLD.closed_at IS NOT NULL AND OLD.closed_at <= clock_timestamp() THEN
    IF NEW.closed_at IS DISTINCT FROM OLD.closed_at THEN
      RAISE EXCEPTION 'reached closed_at cannot be modified';
    END IF;
  ELSIF NEW.closed_at IS NOT NULL THEN
    NEW.closed_at := greatest(NEW.closed_at, clock_timestamp());
  END IF;

  RETURN NEW;
END;
$$;
-- +goose StatementEnd

CREATE TRIGGER accounts_before_update
BEFORE UPDATE OF records_movements, debits_must_not_exceed_credits, credits_must_not_exceed_debits, closed_at ON accounts
FOR EACH ROW
EXECUTE FUNCTION accounts_before_update();
