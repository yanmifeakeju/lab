-- +goose Up
-- Resolution routines: resolve_entry() and resolve_entries() capture or void a
-- pending entry on request. Nothing expires in the ledger; the caller decides
-- when a pending entry is resolved. Each writes a posted resolution entry that copies the pending entry's lines,
-- and closes the pending entry's authorization.
--
-- Lock order, shared with the posting routines: the ledger, request claims,
-- authorizations, then tracked accounts. The posting routines lock no
-- authorizations, so the extra step cannot form a cycle with them.
--
-- Resolutions check neither account closure nor limits. A capture moves an
-- account's exposure from pending to posted without changing the sum the
-- limits bound, and a void lowers it. Refusing either on a closed account
-- would strand the amount in its pending counters.

-- journal_resolution_fingerprint() identifies a resolution request by its
-- content. Its 'operation' key keeps a resolution from ever hashing like a
-- post, so a key reused across the two is a conflict.

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION journal_resolution_fingerprint(
  p_ledger_slug  text,
  p_pending_ref  text,
  p_action       text,
  p_effective_at timestamp with time zone
)
RETURNS text
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
  SELECT encode(
    sha256(
      convert_to(
        jsonb_build_object(
          'operation', 'resolve',
          'ledger_slug', p_ledger_slug,
          'pending_ref', p_pending_ref,
          'action', p_action,
          'effective_at_epoch', CASE
            WHEN p_effective_at IS NULL THEN NULL
            ELSE extract(epoch FROM p_effective_at)
          END
        )::text,
        'UTF8'
      )
    ),
    'hex'
  );
$$;
-- +goose StatementEnd

-- apply_resolution() copies a pending entry's lines into its claimed
-- resolution entry and closes the authorization. The caller holds the
-- authorization lock and has checked that it is still pending.

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION apply_resolution(
  p_authorization_id    bigint,
  p_pending_entry_id    bigint,
  p_resolution_entry_id bigint,
  p_state               text
)
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rows integer;
BEGIN
  -- Before the lines, for the same KEY SHARE reason as in post_entry().
  PERFORM 1
  FROM accounts AS locked
  WHERE locked.id IN (
    SELECT line.debit_account_id
    FROM journal_lines line
    WHERE line.journal_entry_id = p_pending_entry_id
    UNION
    SELECT line.credit_account_id
    FROM journal_lines line
    WHERE line.journal_entry_id = p_pending_entry_id
  )
    AND locked.tracks_balance
  ORDER BY locked.id
  FOR UPDATE;

  INSERT INTO journal_lines
    (journal_entry_id, ledger_id, debit_account_id, credit_account_id,
     line_number, amount, effect, purpose)
  SELECT p_resolution_entry_id, line.ledger_id, line.debit_account_id,
         line.credit_account_id, line.line_number, line.amount,
         CASE WHEN p_state = 'captured' THEN 'pending_posted' ELSE 'pending_voided' END,
         line.purpose
  FROM journal_lines line
  WHERE line.journal_entry_id = p_pending_entry_id
  ORDER BY line.line_number;

  IF p_state = 'captured' THEN
    PERFORM record_posted_movements(p_resolution_entry_id, true);
  ELSE
    UPDATE accounts AS account
    SET debits_pending = account.debits_pending - total.debit,
        credits_pending = account.credits_pending - total.credit
    FROM journal_entry_totals(p_resolution_entry_id) AS total
    WHERE account.id = total.account_id
      AND account.tracks_balance;
  END IF;

  UPDATE authorizations
  SET state = p_state,
      resolution_entry_id = p_resolution_entry_id,
      resolved_at = now()
  WHERE id = p_authorization_id
    AND state = 'pending';

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'authorization % is not pending', p_authorization_id;
  END IF;
END $$;
-- +goose StatementEnd

-- resolve_entry() captures or voids one pending entry, or returns the existing
-- resolution when the idempotency key identifies an identical request. It
-- fails the whole call on the first problem it finds.
--
--   LG001  ledger_not_found
--   LG002  ledger_closed
--   LG020  idempotency_conflict
--   LG031  entry_not_found
--   LG032  entry_not_pending (the entry was posted immediately)
--   LG033  entry_resolved (DETAIL: {"state", "resolution_ref"} of the winner)

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION resolve_entry(
  p_public_ref   text,
  p_ledger_slug  text,
  p_request_id   text,
  p_pending_ref  text,
  p_action       text,
  p_effective_at timestamp with time zone
)
RETURNS TABLE (
  out_public_ref   text,
  out_request_id   text,
  out_kind         text,
  out_description  text,
  out_effective_at timestamp with time zone,
  out_created_at   timestamp with time zone,
  out_pending_ref  text,
  out_state        text,
  out_created      boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ledger        ledgers%ROWTYPE;
  v_pending       journal_entries%ROWTYPE;
  v_entry         journal_entries%ROWTYPE;
  v_existing      journal_entries%ROWTYPE;
  v_authorization authorizations%ROWTYPE;
  v_fingerprint   text;
  v_winner_ref    text;
BEGIN
  IF p_action IS DISTINCT FROM 'capture' AND p_action IS DISTINCT FROM 'void' THEN
    RAISE EXCEPTION 'invalid resolution action: %', p_action USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_ledger
  FROM ledgers
  WHERE slug = p_ledger_slug
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ledger_not_found: %', p_ledger_slug USING ERRCODE = 'LG001';
  END IF;

  v_fingerprint := journal_resolution_fingerprint(
    p_ledger_slug, p_pending_ref, p_action, p_effective_at
  );

  SELECT * INTO v_existing
  FROM journal_entries
  WHERE ledger_id = v_ledger.id
    AND request_id = p_request_id;

  IF NOT FOUND THEN
    IF v_ledger.is_closed THEN
      RAISE EXCEPTION 'ledger_closed: %', p_ledger_slug USING ERRCODE = 'LG002';
    END IF;

    -- Entries are immutable, so reading the pending entry needs no lock.
    SELECT * INTO v_pending
    FROM journal_entries
    WHERE ledger_id = v_ledger.id
      AND public_ref = p_pending_ref;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'entry_not_found: %', p_pending_ref USING ERRCODE = 'LG031';
    END IF;

    INSERT INTO journal_entries
      (public_ref, ledger_id, request_id, fingerprint, kind, description,
       effective_at)
    VALUES
      (p_public_ref, v_ledger.id, p_request_id, v_fingerprint, v_pending.kind,
       v_pending.description, coalesce(p_effective_at, now()))
    ON CONFLICT (ledger_id, request_id) DO NOTHING
    RETURNING * INTO v_entry;

    IF NOT FOUND THEN
      SELECT * INTO v_existing
      FROM journal_entries
      WHERE ledger_id = v_ledger.id
        AND request_id = p_request_id;
    END IF;
  END IF;

  IF v_entry.id IS NULL THEN
    IF v_existing.fingerprint <> v_fingerprint THEN
      RAISE EXCEPTION 'idempotency_conflict: %', p_request_id USING ERRCODE = 'LG020';
    END IF;

    RETURN QUERY
    SELECT v_existing.public_ref, v_existing.request_id, v_existing.kind,
           v_existing.description, v_existing.effective_at,
           v_existing.created_at, p_pending_ref, auth.state, false
    FROM authorizations auth
    WHERE auth.resolution_entry_id = v_existing.id;
    RETURN;
  END IF;

  SELECT * INTO v_authorization
  FROM authorizations
  WHERE entry_id = v_pending.id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'entry_not_pending: %', p_pending_ref USING ERRCODE = 'LG032';
  END IF;

  IF v_authorization.state <> 'pending' THEN
    SELECT public_ref INTO v_winner_ref
    FROM journal_entries
    WHERE id = v_authorization.resolution_entry_id;

    RAISE EXCEPTION 'entry_resolved: %', p_pending_ref
      USING ERRCODE = 'LG033',
            DETAIL = jsonb_build_object(
              'state', v_authorization.state,
              'resolution_ref', v_winner_ref
            )::text;
  END IF;

  PERFORM apply_resolution(
    v_authorization.id,
    v_pending.id,
    v_entry.id,
    CASE WHEN p_action = 'capture' THEN 'captured' ELSE 'voided' END
  );

  RETURN QUERY
  SELECT v_entry.public_ref, v_entry.request_id, v_entry.kind,
         v_entry.description, v_entry.effective_at, v_entry.created_at,
         p_pending_ref,
         CASE WHEN p_action = 'capture' THEN 'captured' ELSE 'voided' END,
         true;
END $$;
-- +goose StatementEnd

-- resolve_entries() resolves 10 to 1,000 pending entries in one transaction,
-- with one outcome per item: created, existing, or rejected. It is to
-- resolve_entry() what post_entries() is to post_entry(), and is separate for
-- the same reason: a subtransaction per item would slow every backend once a
-- batch passes 64 of them. Every check is a query, and rejected claims are
-- deleted before any lines are inserted.
--
-- Whole-batch failures (transaction rollback):
--   LG001  ledger_not_found
--   LG002  ledger_closed, unless every item is a replay
--   LG020  idempotency_conflict (duplicate request id within the batch)
--   LG021  invalid or empty batch
--   LG025  batch_size_exceeded (more than 1,000 items)
--   LG026  batch_lines_exceeded (more than 5,000 copied lines)
--   LG027  batch_too_small (fewer than 10 items)
--   LG035  duplicate_pending_ref (two items name one pending entry)
--
-- Per-item rejection codes:
--   entry_not_found, entry_not_pending, entry_resolved, idempotency_conflict

-- batch_classify_known_resolutions() marks every unclassified item whose
-- request id already exists: existing when the fingerprint matches, rejected
-- with idempotency_conflict when it does not. Called before and after the
-- claims, as post_entries() does with batch_claim_known_entries().

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION batch_classify_known_resolutions(p_ledger_id integer)
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE pg_temp.batch_resolutions_work w
  SET status = CASE WHEN j.fingerprint = w.fingerprint THEN 'existing' ELSE 'rejected' END,
      error_code = CASE WHEN j.fingerprint = w.fingerprint THEN NULL ELSE 'idempotency_conflict' END,
      error_message = CASE
        WHEN j.fingerprint = w.fingerprint THEN NULL
        ELSE 'Idempotency key was previously used with different content.'
      END,
      entry_id = CASE WHEN j.fingerprint = w.fingerprint THEN j.id END,
      public_ref = CASE WHEN j.fingerprint = w.fingerprint THEN j.public_ref ELSE w.public_ref END
  FROM journal_entries j
  WHERE w.status = 'pending'
    AND j.ledger_id = p_ledger_id
    AND j.request_id = w.request_id;
END $$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION resolve_entries(
  p_ledger_slug text,
  p_items       jsonb
)
RETURNS TABLE (
  out_item_index    integer,
  out_request_id    text,
  out_status        text,
  out_error_code    text,
  out_error_message text,
  out_public_ref    text,
  out_pending_ref   text,
  out_state         text,
  out_resolved_by   text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ledger   ledgers%ROWTYPE;
  v_count    integer;
  v_distinct integer;
  v_rows     integer;
BEGIN
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'invalid batch' USING ERRCODE = 'LG021';
  END IF;

  v_count := jsonb_array_length(p_items);
  IF v_count = 0 THEN
    RAISE EXCEPTION 'invalid batch' USING ERRCODE = 'LG021';
  END IF;
  IF v_count < 10 THEN
    RAISE EXCEPTION 'batch_too_small' USING ERRCODE = 'LG027';
  END IF;
  IF v_count > 1000 THEN
    RAISE EXCEPTION 'batch_size_exceeded' USING ERRCODE = 'LG025';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_items) AS item(val)
    WHERE item.val->>'action' IS NULL
       OR item.val->>'action' NOT IN ('capture', 'void')
  ) THEN
    RAISE EXCEPTION 'invalid resolution action' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_ledger
  FROM ledgers
  WHERE slug = p_ledger_slug
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ledger_not_found: %', p_ledger_slug USING ERRCODE = 'LG001';
  END IF;

  CREATE TEMPORARY TABLE IF NOT EXISTS pg_temp.batch_resolutions_work (
    item_index       integer PRIMARY KEY,
    request_id       text NOT NULL,
    public_ref       text NOT NULL,
    pending_ref      text NOT NULL,
    action           text NOT NULL,
    effective_at     timestamp with time zone,
    fingerprint      text NOT NULL,
    status           text NOT NULL DEFAULT 'pending',
    error_code       text,
    error_message    text,
    entry_id         bigint,
    pending_entry_id bigint,
    kind             text,
    description      text,
    authorization_id bigint,
    resolved_state   text,
    resolved_by      text
  ) ON COMMIT DELETE ROWS;
  DELETE FROM pg_temp.batch_resolutions_work;

  INSERT INTO pg_temp.batch_resolutions_work (
    item_index, request_id, public_ref, pending_ref, action, effective_at,
    fingerprint
  )
  SELECT
    (item.ord - 1)::integer,
    item.val->>'request_id',
    item.val->>'public_ref',
    item.val->>'pending_ref',
    item.val->>'action',
    (item.val->>'effective_at')::timestamp with time zone,
    journal_resolution_fingerprint(
      p_ledger_slug,
      item.val->>'pending_ref',
      item.val->>'action',
      (item.val->>'effective_at')::timestamp with time zone
    )
  FROM jsonb_array_elements(p_items) WITH ORDINALITY AS item(val, ord);

  SELECT count(DISTINCT w.request_id) INTO v_distinct FROM pg_temp.batch_resolutions_work w;
  IF v_distinct <> v_count THEN
    RAISE EXCEPTION 'idempotency_conflict: duplicate key within batch' USING ERRCODE = 'LG020';
  END IF;

  SELECT count(DISTINCT w.pending_ref) INTO v_distinct FROM pg_temp.batch_resolutions_work w;
  IF v_distinct <> v_count THEN
    RAISE EXCEPTION 'duplicate_pending_ref' USING ERRCODE = 'LG035';
  END IF;

  -- Entries are immutable, so resolving references needs no lock.
  UPDATE pg_temp.batch_resolutions_work w
  SET pending_entry_id = pending.id,
      kind = pending.kind,
      description = pending.description
  FROM journal_entries pending
  WHERE pending.ledger_id = v_ledger.id
    AND pending.public_ref = w.pending_ref;

  SELECT count(*) INTO v_count
  FROM journal_lines line
  JOIN pg_temp.batch_resolutions_work w ON w.pending_entry_id = line.journal_entry_id;
  IF v_count > 5000 THEN
    RAISE EXCEPTION 'batch_lines_exceeded' USING ERRCODE = 'LG026';
  END IF;

  PERFORM batch_classify_known_resolutions(v_ledger.id);

  IF v_ledger.is_closed THEN
    IF EXISTS (SELECT 1 FROM pg_temp.batch_resolutions_work WHERE status <> 'existing') THEN
      RAISE EXCEPTION 'ledger_closed: %', p_ledger_slug USING ERRCODE = 'LG002';
    END IF;
  END IF;

  UPDATE pg_temp.batch_resolutions_work w
  SET status = 'rejected',
      error_code = 'entry_not_found',
      error_message = 'Entry not found.'
  WHERE w.status = 'pending'
    AND w.pending_entry_id IS NULL;

  -- Claims in request-id order, as post_entries() takes them.
  WITH inserted AS (
    INSERT INTO journal_entries (
      public_ref, ledger_id, request_id, fingerprint, kind, description,
      effective_at
    )
    SELECT w.public_ref, v_ledger.id, w.request_id, w.fingerprint, w.kind,
           w.description, coalesce(w.effective_at, now())
    FROM pg_temp.batch_resolutions_work w
    WHERE w.status = 'pending'
    ORDER BY w.request_id COLLATE "C"
    ON CONFLICT (ledger_id, request_id) DO NOTHING
    RETURNING id, request_id
  )
  UPDATE pg_temp.batch_resolutions_work w
  SET status = 'claimed',
      entry_id = i.id
  FROM inserted i
  WHERE w.request_id = i.request_id;

  PERFORM batch_classify_known_resolutions(v_ledger.id);

  IF EXISTS (SELECT 1 FROM pg_temp.batch_resolutions_work WHERE status = 'pending') THEN
    RAISE EXCEPTION 'request id claim did not resolve' USING ERRCODE = '40001';
  END IF;

  PERFORM 1
  FROM authorizations auth
  WHERE auth.entry_id IN (
    SELECT w.pending_entry_id FROM pg_temp.batch_resolutions_work w WHERE w.status = 'claimed'
  )
  ORDER BY auth.id
  FOR UPDATE;

  -- Everything below is read after the authorization locks.
  UPDATE pg_temp.batch_resolutions_work w
  SET authorization_id = auth.id
  FROM authorizations auth
  WHERE w.status = 'claimed'
    AND auth.entry_id = w.pending_entry_id;

  UPDATE pg_temp.batch_resolutions_work w
  SET status = 'rejected',
      error_code = 'entry_not_pending',
      error_message = 'Entry was posted immediately and has nothing to resolve.'
  WHERE w.status = 'claimed'
    AND w.authorization_id IS NULL;

  UPDATE pg_temp.batch_resolutions_work w
  SET status = 'rejected',
      error_code = 'entry_resolved',
      error_message = 'Entry is already ' || auth.state || '.',
      resolved_state = auth.state,
      resolved_by = winner.public_ref
  FROM authorizations auth
  JOIN journal_entries winner ON winner.id = auth.resolution_entry_id
  WHERE w.status = 'claimed'
    AND auth.id = w.authorization_id
    AND auth.state <> 'pending';

  -- Before the lines, for the same KEY SHARE reason as in post_entry().
  PERFORM 1
  FROM accounts a
  WHERE a.id IN (
    SELECT line.debit_account_id
    FROM journal_lines line
    JOIN pg_temp.batch_resolutions_work w ON w.pending_entry_id = line.journal_entry_id
    WHERE w.status = 'claimed'
    UNION
    SELECT line.credit_account_id
    FROM journal_lines line
    JOIN pg_temp.batch_resolutions_work w ON w.pending_entry_id = line.journal_entry_id
    WHERE w.status = 'claimed'
  )
    AND a.tracks_balance
  ORDER BY a.id
  FOR UPDATE;

  DELETE FROM journal_entries j
  USING pg_temp.batch_resolutions_work w
  WHERE w.status = 'rejected'
    AND w.entry_id = j.id;

  UPDATE pg_temp.batch_resolutions_work w
  SET status = 'created',
      resolved_state = CASE WHEN w.action = 'capture' THEN 'captured' ELSE 'voided' END
  WHERE w.status = 'claimed';

  INSERT INTO journal_lines (
    journal_entry_id, ledger_id, debit_account_id, credit_account_id,
    line_number, amount, effect, purpose
  )
  SELECT w.entry_id, line.ledger_id, line.debit_account_id,
         line.credit_account_id, line.line_number, line.amount,
         CASE WHEN w.action = 'capture' THEN 'pending_posted' ELSE 'pending_voided' END,
         line.purpose
  FROM pg_temp.batch_resolutions_work w
  JOIN journal_lines line ON line.journal_entry_id = w.pending_entry_id
  WHERE w.status = 'created'
  ORDER BY w.item_index, line.line_number;

  -- Captures write movements with gapless sequences across the batch, in item
  -- order, and one recorded_at per account. Counters move once per account.
  WITH capture_lines AS (
    SELECT line.debit_account_id AS account_id, w.entry_id AS journal_entry_id,
           w.item_index, line.line_number, 'debit'::text AS direction,
           line.amount, -line.amount AS signed_amount, line.purpose
    FROM pg_temp.batch_resolutions_work w
    JOIN journal_lines line ON line.journal_entry_id = w.entry_id
    JOIN accounts a ON a.id = line.debit_account_id
    WHERE w.status = 'created'
      AND w.action = 'capture'
      AND a.records_movements

    UNION ALL

    SELECT line.credit_account_id, w.entry_id, w.item_index, line.line_number,
           'credit'::text, line.amount, line.amount, line.purpose
    FROM pg_temp.batch_resolutions_work w
    JOIN journal_lines line ON line.journal_entry_id = w.entry_id
    JOIN accounts a ON a.id = line.credit_account_id
    WHERE w.status = 'created'
      AND w.action = 'capture'
      AND a.records_movements
  ),
  account_prev AS (
    SELECT a.id AS account_id, a.movement_count,
           coalesce(prev.balance_after, 0::bigint) AS prev_balance_after,
           greatest(clock_timestamp(), prev.recorded_at) AS recorded_at
    FROM accounts a
    LEFT JOIN account_movements prev
      ON prev.account_id = a.id
     AND prev.sequence = a.movement_count
    WHERE a.id IN (SELECT DISTINCT account_id FROM capture_lines)
  ),
  inserted_movements AS (
    INSERT INTO account_movements (
      account_id, sequence, journal_entry_id, line_number, direction, amount,
      purpose, balance_after, recorded_at
    )
    SELECT
      lines.account_id,
      prev.movement_count + row_number() OVER (
        PARTITION BY lines.account_id
        ORDER BY lines.item_index, lines.line_number
      ),
      lines.journal_entry_id,
      lines.line_number,
      lines.direction,
      lines.amount,
      lines.purpose,
      prev.prev_balance_after + sum(lines.signed_amount) OVER (
        PARTITION BY lines.account_id
        ORDER BY lines.item_index, lines.line_number
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
      ),
      prev.recorded_at
    FROM capture_lines lines
    JOIN account_prev prev ON prev.account_id = lines.account_id
    ORDER BY lines.account_id, lines.item_index, lines.line_number
    RETURNING account_id
  ),
  movement_counts AS (
    SELECT im.account_id, count(*)::bigint AS cnt
    FROM inserted_movements im
    GROUP BY im.account_id
  ),
  account_totals AS (
    SELECT mov.account_id,
           sum(mov.debit)::bigint AS debit,
           sum(mov.credit)::bigint AS credit,
           sum(mov.debit) FILTER (WHERE mov.capture)::bigint AS captured_debit,
           sum(mov.credit) FILTER (WHERE mov.capture)::bigint AS captured_credit
    FROM (
      SELECT line.debit_account_id AS account_id, line.amount AS debit,
             0::bigint AS credit, w.action = 'capture' AS capture
      FROM pg_temp.batch_resolutions_work w
      JOIN journal_lines line ON line.journal_entry_id = w.entry_id
      WHERE w.status = 'created'
      UNION ALL
      SELECT line.credit_account_id, 0::bigint, line.amount,
             w.action = 'capture'
      FROM pg_temp.batch_resolutions_work w
      JOIN journal_lines line ON line.journal_entry_id = w.entry_id
      WHERE w.status = 'created'
    ) AS mov
    GROUP BY mov.account_id
  )
  UPDATE accounts a
  SET debits_pending = a.debits_pending - tot.debit,
      credits_pending = a.credits_pending - tot.credit,
      debits_posted = a.debits_posted + coalesce(tot.captured_debit, 0),
      credits_posted = a.credits_posted + coalesce(tot.captured_credit, 0),
      movement_count = a.movement_count + coalesce(mc.cnt, 0)
  FROM account_totals tot
  LEFT JOIN movement_counts mc ON mc.account_id = tot.account_id
  WHERE a.id = tot.account_id
    AND a.tracks_balance;

  UPDATE authorizations auth
  SET state = w.resolved_state,
      resolution_entry_id = w.entry_id,
      resolved_at = now()
  FROM pg_temp.batch_resolutions_work w
  WHERE w.status = 'created'
    AND auth.id = w.authorization_id
    AND auth.state = 'pending';

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  SELECT count(*) INTO v_count FROM pg_temp.batch_resolutions_work WHERE status = 'created';
  IF v_rows <> v_count THEN
    RAISE EXCEPTION 'resolved % authorizations for % items', v_rows, v_count;
  END IF;

  RETURN QUERY
  SELECT
    w.item_index,
    w.request_id,
    w.status,
    w.error_code,
    w.error_message,
    CASE WHEN w.status = 'rejected' THEN NULL ELSE w.public_ref END,
    w.pending_ref,
    CASE
      WHEN w.status = 'existing' THEN existing_auth.state
      ELSE w.resolved_state
    END,
    w.resolved_by
  FROM pg_temp.batch_resolutions_work w
  LEFT JOIN authorizations existing_auth
    ON w.status = 'existing'
   AND existing_auth.resolution_entry_id = w.entry_id
  ORDER BY w.item_index;
END $$;
-- +goose StatementEnd
