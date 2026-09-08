-- +goose Up
CREATE TABLE "journal_entries" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "journal_entries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"public_ref" text COLLATE "C" NOT NULL,
	"ledger_id" integer NOT NULL,
	"request_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"kind" text NOT NULL,
	"state" text NOT NULL,
	"description" text,
	"expires_at" timestamp with time zone,
	"pending_entry_id" bigint,
	"effective_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journal_entries_public_ref_unique" UNIQUE ("public_ref"),
	CONSTRAINT "journal_entries_public_ref_valid" CHECK ("journal_entries"."public_ref" ~ '^jrn_[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
	CONSTRAINT "journal_entries_request_id_not_blank" CHECK (length(btrim("journal_entries"."request_id")) > 0),
	CONSTRAINT "journal_entries_request_id_length" CHECK (length("journal_entries"."request_id") <= 255),
	CONSTRAINT "journal_entries_fingerprint_not_blank" CHECK (length(btrim("journal_entries"."fingerprint")) > 0),
	CONSTRAINT "journal_entries_kind_valid" CHECK ("journal_entries"."kind" in ('payment', 'settlement', 'transfer')),
	CONSTRAINT "journal_entries_state_valid" CHECK ("journal_entries"."state" in ('pending', 'posted', 'captured', 'voided', 'expired')),
	CONSTRAINT "journal_entries_pending_has_expiry" CHECK ("journal_entries"."state" <> 'pending' or "journal_entries"."expires_at" is not null),
	CONSTRAINT "journal_entries_terminal_has_expiry" CHECK ("journal_entries"."state" not in ('captured', 'voided', 'expired') or "journal_entries"."expires_at" is not null),
	CONSTRAINT "journal_entries_resolution_is_posted" CHECK ("journal_entries"."pending_entry_id" is null or "journal_entries"."state" = 'posted'),
	CONSTRAINT "journal_entries_not_self_referencing" CHECK ("journal_entries"."pending_entry_id" is null or "journal_entries"."pending_entry_id" <> "journal_entries"."id"),
	CONSTRAINT "journal_entries_id_ledger_id_unique" UNIQUE ("id", "ledger_id"),
	CONSTRAINT "journal_entries_ledger_request_id_unique" UNIQUE ("ledger_id", "request_id")
);

ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_ledger_id_ledgers_id_fk" FOREIGN KEY ("ledger_id") REFERENCES "public"."ledgers"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_pending_entry_ledger_fk" FOREIGN KEY ("pending_entry_id", "ledger_id") REFERENCES "public"."journal_entries"("id", "ledger_id") ON DELETE no action ON UPDATE no action;

CREATE UNIQUE INDEX "journal_entries_pending_entry_key" ON "journal_entries" USING btree ("pending_entry_id") WHERE "pending_entry_id" is not null;
CREATE INDEX "journal_entries_ledger_effective_idx" ON "journal_entries" USING btree ("ledger_id", "effective_at" DESC, "id" DESC);
CREATE INDEX "journal_entries_expiry_idx" ON "journal_entries" USING btree ("expires_at") WHERE "state" = 'pending';

ALTER TABLE "accounts" ADD CONSTRAINT "accounts_id_ledger_id_unique" UNIQUE ("id", "ledger_id");

CREATE TABLE "journal_lines" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "journal_lines_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"journal_entry_id" bigint NOT NULL,
	"ledger_id" integer NOT NULL,
	"debit_account_id" bigint NOT NULL,
	"credit_account_id" bigint NOT NULL,
	"line_number" smallint NOT NULL,
	"amount" bigint NOT NULL,
	"effect" text NOT NULL,
	CONSTRAINT "journal_lines_line_number_positive" CHECK ("journal_lines"."line_number" > 0),
	CONSTRAINT "journal_lines_amount_positive" CHECK ("journal_lines"."amount" > 0),
	CONSTRAINT "journal_lines_effect_valid" CHECK ("journal_lines"."effect" in ('pending', 'posted', 'pending_posted', 'pending_voided')),
	CONSTRAINT "journal_lines_no_self_transfer" CHECK ("journal_lines"."debit_account_id" <> "journal_lines"."credit_account_id"),
	CONSTRAINT "journal_lines_entry_line_number_unique" UNIQUE ("journal_entry_id", "line_number")
);

ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_entry_ledger_fk" FOREIGN KEY ("journal_entry_id", "ledger_id") REFERENCES "public"."journal_entries"("id", "ledger_id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_debit_account_ledger_fk" FOREIGN KEY ("debit_account_id", "ledger_id") REFERENCES "public"."accounts"("id", "ledger_id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_credit_account_ledger_fk" FOREIGN KEY ("credit_account_id", "ledger_id") REFERENCES "public"."accounts"("id", "ledger_id") ON DELETE no action ON UPDATE no action;

CREATE INDEX "journal_lines_debit_account_idx" ON "journal_lines" USING btree ("debit_account_id", "ledger_id", "journal_entry_id");
CREATE INDEX "journal_lines_credit_account_idx" ON "journal_lines" USING btree ("credit_account_id", "ledger_id", "journal_entry_id");
