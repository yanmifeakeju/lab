-- Payments that succeeded before postings existed get the posting simulate now
-- writes with them, so the relay sends them like any other. The ID reuses the
-- payment's ULID, which is unique already.
INSERT INTO "ledger_postings" ("id", "business_id", "ledger", "payment_id", "kind", "description", "effective_at", "lines")
SELECT
	'lpost_' || substr(p."id", 5),
	p."business_id",
	p."ledger",
	p."id",
	'payment',
	'Payment ' || p."id" || ' via link ' || p."link_id",
	date_trunc('milliseconds', p."completed_at"),
	jsonb_build_array(jsonb_build_object(
		'debit_account_ref', cash."ledger_account_ref",
		'credit_account_ref', b."primary_payable_account_ref",
		'amount', p."amount"::text,
		'purpose', 'payment'
	))
FROM "payments" p
JOIN "businesses" b ON b."id" = p."business_id"
JOIN "platform_accounts" cash ON cash."ledger" = p."ledger" AND cash."label" = 'cash'
WHERE p."status" = 'succeeded' AND b."primary_payable_account_ref" IS NOT NULL;
