-- +goose Up
CREATE TABLE "ledgers" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ledgers_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"slug" text NOT NULL,
	"currency" char(3) NOT NULL,
	"scale" smallint NOT NULL,
	"description" text,
	"is_closed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledgers_slug_unique" UNIQUE("slug"),
	CONSTRAINT "ledgers_scale_range" CHECK ("ledgers"."scale" between 0 and 4),
	CONSTRAINT "ledgers_currency_iso4217" CHECK ("ledgers"."currency" ~ '^[A-Z]{3}$')
);
