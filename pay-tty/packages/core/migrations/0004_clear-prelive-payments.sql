-- Pre-live links and payments carry no ledger, and the next migration adds it
-- as not null. Businesses and ledger configuration stay.
DELETE FROM "payments";--> statement-breakpoint
DELETE FROM "payment_links";
