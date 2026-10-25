-- Links and payments read their currency and scale through their ledger, so
-- changing either would change what every stored amount means. The slug may
-- still change; it cascades.
CREATE FUNCTION ledgers_currency_scale_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'ledger % cannot change its currency or scale', OLD.slug
		USING ERRCODE = 'integrity_constraint_violation';
END
$$;--> statement-breakpoint
CREATE TRIGGER ledgers_currency_scale_immutable
BEFORE UPDATE OF currency, scale ON ledgers
FOR EACH ROW
WHEN (NEW.currency IS DISTINCT FROM OLD.currency OR NEW.scale IS DISTINCT FROM OLD.scale)
EXECUTE FUNCTION ledgers_currency_scale_immutable();
