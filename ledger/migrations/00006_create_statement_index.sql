-- +goose Up
CREATE INDEX "journal_entries_ledger_recorded_idx"
ON "journal_entries" USING btree ("ledger_id", "created_at", "id");
