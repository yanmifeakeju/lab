-- +goose Up
-- create_payable_account(): onboards a merchant's `payable` account.
--
-- A payable account carries a holder as its external identity, so onboarding
-- creates both together or neither. The account is the aggregate; the holder
-- exists only to back it. Platform accounts (treasury, receivable, fee_revenue)
-- are seeded separately per ledger.
--
--   LG001  ledger_not_found
--   LG002  ledger_closed
--   LG003  holder_conflict

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION create_payable_account(
  p_external_id text,
  p_name        text,
  p_ledger_slug text,
  p_holder_ref  text,
  p_account_ref text
)
RETURNS TABLE (
  out_id            bigint,
  out_account_ref   text,
  out_ledger_id     integer,
  out_kind          text,
  out_channel       text,
  out_holder_id     bigint,
  out_holder_ref    text,
  out_holder_name   text,
  out_description   text,
  out_debits_pending             bigint,
  out_credits_pending            bigint,
  out_debits_posted              bigint,
  out_credits_posted             bigint,
  out_debits_must_not_exceed_credits  boolean,
  out_credits_must_not_exceed_debits boolean,
  out_is_closed     boolean,
  out_created_at    timestamp with time zone,
  out_created boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ledger ledgers%ROWTYPE;
  v_holder holders%ROWTYPE;
  v_rows integer;
  v_created boolean;
BEGIN
  SELECT * INTO v_ledger FROM ledgers WHERE slug = p_ledger_slug;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ledger_not_found: %', p_ledger_slug USING ERRCODE = 'LG001';
  END IF;
  IF v_ledger.is_closed THEN
    RAISE EXCEPTION 'ledger_closed: %', p_ledger_slug USING ERRCODE = 'LG002';
  END IF;

  -- A retry returns the same holder rather than failing on the unique index.
  -- The same id with a different name is a caller bug, and returning the old
  -- row would hide it.
  INSERT INTO holders (public_ref, external_id, name)
  VALUES (p_holder_ref, p_external_id, p_name)
  ON CONFLICT (external_id) DO NOTHING
  RETURNING * INTO v_holder;

  IF NOT FOUND THEN
    SELECT * INTO v_holder FROM holders WHERE external_id = p_external_id;
    IF v_holder.name IS DISTINCT FROM p_name THEN
      RAISE EXCEPTION 'holder_conflict: %', p_external_id USING ERRCODE = 'LG003';
    END IF;
  END IF;

  -- ON CONFLICT is what lets a retry, or the same account onboarding onto a
  -- second ledger, add only what is missing.
  INSERT INTO accounts (public_ref, ledger_id, kind, holder_id, channel, debits_must_not_exceed_credits)
  VALUES (p_account_ref, v_ledger.id, 'payable', v_holder.id, NULL, true)
  ON CONFLICT (holder_id, ledger_id, kind) WHERE holder_id IS NOT NULL
  DO NOTHING;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  v_created := v_rows = 1;

  RETURN QUERY
  SELECT a.id, a.public_ref, a.ledger_id, a.kind, a.channel, a.holder_id,
         h.public_ref, h.name, a.description,
         a.debits_pending, a.credits_pending,
         a.debits_posted, a.credits_posted,
         a.debits_must_not_exceed_credits, a.credits_must_not_exceed_debits,
         a.is_closed, a.created_at, v_created
  FROM accounts a
  JOIN holders h ON h.id = a.holder_id
  WHERE a.holder_id = v_holder.id AND a.ledger_id = v_ledger.id AND a.kind = 'payable';
END $$;
-- +goose StatementEnd
