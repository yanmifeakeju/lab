-- +goose Up
-- btrim strips only spaces, so the previous checks accepted values made
-- entirely of tabs or newlines. The regex mirrors the API's '.*\S.*'.
ALTER TABLE "holders" DROP CONSTRAINT "holders_name_not_blank";
ALTER TABLE "holders" ADD CONSTRAINT "holders_name_not_blank" CHECK ("holders"."name" ~ '\S');

ALTER TABLE "journal_entries" DROP CONSTRAINT "journal_entries_request_id_not_blank";
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_request_id_not_blank" CHECK ("journal_entries"."request_id" ~ '\S');

ALTER TABLE "journal_entries" DROP CONSTRAINT "journal_entries_fingerprint_not_blank";
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_fingerprint_not_blank" CHECK ("journal_entries"."fingerprint" ~ '\S');
