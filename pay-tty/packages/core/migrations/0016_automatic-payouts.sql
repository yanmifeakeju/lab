ALTER TABLE "payout_settings" ADD COLUMN "automatic_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payout_settings" ADD COLUMN "last_run_on" date;--> statement-breakpoint
-- Already automatic before this column: since their settings were last saved.
UPDATE "payout_settings" SET "automatic_since" = "updated_at" WHERE "mode" = 'automatic';--> statement-breakpoint
ALTER TABLE "payout_settings" ADD CONSTRAINT "payout_settings_automatic_since" CHECK (("payout_settings"."mode" = 'automatic') = ("payout_settings"."automatic_since" is not null));