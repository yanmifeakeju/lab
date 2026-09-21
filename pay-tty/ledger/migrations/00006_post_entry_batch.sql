-- +goose Up
-- post_entries() posts 10 to 1,000 journal entries in a single database
-- transaction, committing all accepted entries under a single commit flush.
-- Each entry receives an individual outcome: created, existing, or rejected.
--
-- The lower bound is not arbitrary. Setting up the batch costs about what ten
-- single postings cost, so a smaller batch is slower than the same entries
-- sent to post_entry() one at a time. Callers with fewer than ten entries to
-- flush belong on that routine.
--
-- It shares its fingerprint, limit arithmetic and entry totals with
-- post_entry() (migration 00005) but not its control flow: this routine
-- records an outcome per entry, where post_entry() raises on the first
-- problem. Handling each entry here in its own BEGIN ... EXCEPTION block would
-- open a subtransaction per entry, and past 64 subtransactions in one
-- transaction Postgres slows every backend, not only this one.
--
-- Whole-batch failures (transaction rollback):
--   LG001  ledger_not_found
--   LG002  ledger_closed
--   LG020  idempotency_conflict (duplicate request_id within batch)
--   LG021  no_lines (or empty/invalid batch)
--   LG025  batch_size_exceeded (exceeds 1,000 entries)
--   LG026  batch_lines_exceeded (exceeds 5,000 lines total)
--   LG027  batch_too_small (fewer than 10 entries)
--
-- Per-entry rejection codes (individual entry outcome):
--   account_not_found
--   account_closed
--   insufficient_funds
--   idempotency_conflict

-- batch_claim_known_entries() marks every still-pending entry whose request id
-- already exists in the ledger: existing when the fingerprint matches,
-- rejected with idempotency_conflict when it does not. post_entries() calls it
-- before and after claiming new request ids through the journal_entries unique
-- key; the second call classifies any concurrent winner the insert waited for.

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION batch_claim_known_entries(p_ledger_id integer)
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE pg_temp.batch_entries_work w
  SET status = CASE
        WHEN j.fingerprint = w.fingerprint THEN 'existing'
        ELSE 'rejected'
      END,
      error_code = CASE
        WHEN j.fingerprint = w.fingerprint THEN NULL
        ELSE 'idempotency_conflict'
      END,
      error_message = CASE
        WHEN j.fingerprint = w.fingerprint THEN NULL
        ELSE 'Idempotency key was previously used with different content.'
      END,
      entry_id = CASE
        WHEN j.fingerprint = w.fingerprint THEN j.id
        ELSE NULL
      END,
      public_ref = CASE
        WHEN j.fingerprint = w.fingerprint THEN j.public_ref
        ELSE w.public_ref
      END,
      effective_at = CASE
        WHEN j.fingerprint = w.fingerprint THEN j.effective_at
        ELSE w.effective_at
      END,
      created_at = CASE
        WHEN j.fingerprint = w.fingerprint THEN j.created_at
        ELSE NULL
      END
  FROM journal_entries j
  WHERE w.status = 'pending'
    AND j.ledger_id = p_ledger_id
    AND j.request_id = w.request_id;
END $$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION post_entries(
  p_ledger_slug text,
  p_entries     jsonb
)
RETURNS TABLE (
  out_entry_index      integer,
  out_request_id       text,
  out_status           text,
  out_error_code       text,
  out_error_message    text,
  out_id               bigint,
  out_public_ref       text,
  out_ledger_id        integer,
  out_kind             text,
  out_state            text,
  out_description      text,
  out_expires_at       timestamp with time zone,
  out_pending_entry_id bigint,
  out_effective_at     timestamp with time zone,
  out_created_at       timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ledger      ledgers%ROWTYPE;
  v_count       integer;
  v_dist_count  integer;
  v_cur_entry   RECORD;
  v_acct        RECORD;
  v_entry_ok    boolean;
BEGIN
  IF jsonb_typeof(p_entries) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'no_lines' USING ERRCODE = 'LG021';
  END IF;

  v_count := jsonb_array_length(p_entries);
  IF v_count = 0 THEN
    RAISE EXCEPTION 'no_lines' USING ERRCODE = 'LG021';
  END IF;

  IF v_count < 10 THEN
    RAISE EXCEPTION 'batch_too_small' USING ERRCODE = 'LG027';
  END IF;

  IF v_count > 1000 THEN
    RAISE EXCEPTION 'batch_size_exceeded' USING ERRCODE = 'LG025';
  END IF;

  SELECT * INTO v_ledger
  FROM ledgers
  WHERE slug = p_ledger_slug
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ledger_not_found: %', p_ledger_slug USING ERRCODE = 'LG001';
  END IF;

  -- Create temporary working table for the batch
  CREATE TEMPORARY TABLE IF NOT EXISTS pg_temp.batch_entries_work (
    entry_index      integer PRIMARY KEY,
    request_id       text NOT NULL,
    public_ref       text NOT NULL,
    kind             text NOT NULL,
    description      text NOT NULL,
    effective_at     timestamp with time zone,
    fingerprint      text NOT NULL,
    status           text NOT NULL DEFAULT 'pending',
    error_code       text,
    error_message    text,
    entry_id         bigint,
    created_at       timestamp with time zone,
    lines            jsonb
  ) ON COMMIT DELETE ROWS;
  DELETE FROM pg_temp.batch_entries_work;

  -- 1. Parse entries and compute deterministic fingerprints
  INSERT INTO pg_temp.batch_entries_work (
    entry_index,
    request_id,
    public_ref,
    kind,
    description,
    effective_at,
    fingerprint,
    lines
  )
  SELECT
    (entry.ord - 1)::integer,
    coalesce(entry.val->>'idempotency_key', entry.val->>'request_id'),
    entry.val->>'public_ref',
    entry.val->>'kind',
    entry.val->>'description',
    CASE
      WHEN entry.val->>'effective_at' IS NOT NULL
      THEN (entry.val->>'effective_at')::timestamp with time zone
      ELSE NULL
    END,
    journal_fingerprint(
      p_ledger_slug,
      entry.val->>'kind',
      entry.val->>'description',
      (entry.val->>'effective_at')::timestamp with time zone,
      entry.val->'lines'
    ),
    entry.val->'lines'
  FROM jsonb_array_elements(p_entries) WITH ORDINALITY AS entry(val, ord);

  -- Check for duplicate idempotency keys within the batch
  SELECT count(*), count(DISTINCT bw.request_id)
  INTO v_count, v_dist_count
  FROM pg_temp.batch_entries_work bw;

  IF v_count <> v_dist_count THEN
    RAISE EXCEPTION 'idempotency_conflict: duplicate key within batch' USING ERRCODE = 'LG020';
  END IF;

  -- Check that every entry has a valid, non-empty lines array
  IF EXISTS (
    SELECT 1
    FROM pg_temp.batch_entries_work bw
    WHERE bw.lines IS NULL
       OR jsonb_typeof(bw.lines) IS DISTINCT FROM 'array'
       OR jsonb_array_length(bw.lines) = 0
  ) THEN
    RAISE EXCEPTION 'no_lines' USING ERRCODE = 'LG021';
  END IF;

  -- Check total lines limit across the entire batch (cap at 5,000 lines)
  SELECT coalesce(sum(jsonb_array_length(bw.lines)), 0)
  INTO v_count
  FROM pg_temp.batch_entries_work bw;

  IF v_count > 5000 THEN
    RAISE EXCEPTION 'batch_lines_exceeded' USING ERRCODE = 'LG026';
  END IF;

  -- 2. Classify keys that already exist before deciding whether a closed
  -- ledger is seeing only identical replays.
  PERFORM batch_claim_known_entries(v_ledger.id);

  -- If the ledger is closed, only an identical replay of every entry is
  -- permitted. A conflicting use of an existing key is not a replay.
  IF v_ledger.is_closed THEN
    IF EXISTS (SELECT 1 FROM pg_temp.batch_entries_work WHERE status <> 'existing') THEN
      RAISE EXCEPTION 'ledger_closed: %', p_ledger_slug USING ERRCODE = 'LG002';
    END IF;
  END IF;

  -- Claim every new request id before taking account locks. The unique index is
  -- the idempotency lock: a concurrent claimant waits here, then the second
  -- classification below sees the winner. Sorting gives overlapping batches
  -- one request-id order. Rejected claims are deleted before this transaction
  -- commits, so their keys remain reusable.
  WITH inserted AS (
    INSERT INTO journal_entries (
      public_ref,
      ledger_id,
      request_id,
      fingerprint,
      kind,
      state,
      description,
      effective_at
    )
    SELECT
      w.public_ref,
      v_ledger.id,
      w.request_id,
      w.fingerprint,
      w.kind,
      'posted',
      w.description,
      coalesce(w.effective_at, now())
    FROM pg_temp.batch_entries_work w
    WHERE w.status = 'pending'
    ORDER BY w.request_id COLLATE "C"
    ON CONFLICT (ledger_id, request_id) DO NOTHING
    RETURNING id, request_id, public_ref, effective_at, created_at
  )
  UPDATE pg_temp.batch_entries_work w
  SET status = 'claimed',
      entry_id = i.id,
      public_ref = i.public_ref,
      effective_at = i.effective_at,
      created_at = i.created_at
  FROM inserted i
  WHERE w.request_id = i.request_id;

  PERFORM batch_claim_known_entries(v_ledger.id);

  IF EXISTS (SELECT 1 FROM pg_temp.batch_entries_work WHERE status = 'pending') THEN
    RAISE EXCEPTION 'request id claim did not resolve' USING ERRCODE = '40001';
  END IF;

  -- 3. Parse and resolve lines for entries claimed by this transaction
  CREATE TEMPORARY TABLE IF NOT EXISTS pg_temp.batch_lines_work (
    entry_index            integer NOT NULL,
    line_number            smallint NOT NULL,
    debit_account_ref      text NOT NULL,
    credit_account_ref     text NOT NULL,
    debit_account_id       bigint,
    credit_account_id      bigint,
    amount                 bigint NOT NULL,
    purpose                text NOT NULL,
    PRIMARY KEY (entry_index, line_number)
  ) ON COMMIT DELETE ROWS;
  DELETE FROM pg_temp.batch_lines_work;

  INSERT INTO pg_temp.batch_lines_work (
    entry_index,
    line_number,
    debit_account_ref,
    credit_account_ref,
    debit_account_id,
    credit_account_id,
    amount,
    purpose
  )
  SELECT
    w.entry_index,
    l.ord::smallint,
    l.line->>'debit_account_ref',
    l.line->>'credit_account_ref',
    d.id,
    c.id,
    (l.line->>'amount')::bigint,
    l.line->>'purpose'
  FROM pg_temp.batch_entries_work w
  CROSS JOIN LATERAL jsonb_array_elements(w.lines) WITH ORDINALITY AS l(line, ord)
  LEFT JOIN accounts d
    ON d.public_ref = (l.line->>'debit_account_ref')
   AND d.ledger_id = v_ledger.id
  LEFT JOIN accounts c
    ON c.public_ref = (l.line->>'credit_account_ref')
   AND c.ledger_id = v_ledger.id
  WHERE w.status = 'claimed';

  -- Reject entries with unresolved accounts (account_not_found)
  UPDATE pg_temp.batch_entries_work w
  SET status = 'rejected',
      error_code = 'account_not_found',
      error_message = 'Account not found.'
  WHERE w.status = 'claimed'
    AND w.entry_index IN (
      SELECT DISTINCT entry_index
      FROM pg_temp.batch_lines_work
      WHERE debit_account_id IS NULL OR credit_account_id IS NULL
    );

  -- 4. Lock every account that tracks a balance and is named by a remaining entry
  PERFORM 1
  FROM accounts a
  WHERE a.id IN (
    SELECT DISTINCT bl.debit_account_id
    FROM pg_temp.batch_lines_work bl
    JOIN pg_temp.batch_entries_work w ON w.entry_index = bl.entry_index AND w.status = 'claimed'
    UNION
    SELECT DISTINCT bl.credit_account_id
    FROM pg_temp.batch_lines_work bl
    JOIN pg_temp.batch_entries_work w ON w.entry_index = bl.entry_index AND w.status = 'claimed'
  )
    AND a.tracks_balance
  ORDER BY a.id
  FOR UPDATE;

  -- 5. Check for closed accounts (account_closed)
  --
  -- After the lock, not before: a closure in flight during an earlier check
  -- would still be uncommitted, the batch would read the account as open, wait
  -- for the lock the closure holds, and then post to it. After the claim too,
  -- so a replay is not refused for a closure that followed its original post.
  --
  -- This only serialises accounts the batch locks, which is every account that
  -- tracks a balance. A platform account keeping no counters is not locked and
  -- can still close under a posting; that is the accepted behaviour for those
  -- accounts, whose balances are derived from journal_lines downstream.
  UPDATE pg_temp.batch_entries_work w
  SET status = 'rejected',
      error_code = 'account_closed',
      error_message = 'Account is closed.'
  WHERE w.status = 'claimed'
    AND w.entry_index IN (
      SELECT bl.entry_index
      FROM pg_temp.batch_lines_work bl
      JOIN accounts a ON a.id = bl.debit_account_id
      WHERE a.closed_at IS NOT NULL
        AND a.closed_at <= clock_timestamp()
      UNION
      SELECT bl.entry_index
      FROM pg_temp.batch_lines_work bl
      JOIN accounts a ON a.id = bl.credit_account_id
      WHERE a.closed_at IS NOT NULL
        AND a.closed_at <= clock_timestamp()
    );

  -- 6. Check balance limits in batch order in memory
  -- Load current balances for all locked accounts touched by claimed entries
  CREATE TEMPORARY TABLE IF NOT EXISTS pg_temp.batch_account_balances (
    account_id                     bigint PRIMARY KEY,
    debits_must_not_exceed_credits boolean NOT NULL,
    credits_must_not_exceed_debits boolean NOT NULL,
    debits_pending                 bigint NOT NULL,
    credits_pending                bigint NOT NULL,
    debits_posted                  bigint NOT NULL,
    credits_posted                 bigint NOT NULL
  ) ON COMMIT DELETE ROWS;
  DELETE FROM pg_temp.batch_account_balances;

  INSERT INTO pg_temp.batch_account_balances (
    account_id,
    debits_must_not_exceed_credits,
    credits_must_not_exceed_debits,
    debits_pending,
    credits_pending,
    debits_posted,
    credits_posted
  )
  SELECT
    a.id,
    a.debits_must_not_exceed_credits,
    a.credits_must_not_exceed_debits,
    a.debits_pending,
    a.credits_pending,
    a.debits_posted,
    a.credits_posted
  FROM accounts a
  WHERE a.id IN (
    SELECT DISTINCT bl.debit_account_id
    FROM pg_temp.batch_lines_work bl
    JOIN pg_temp.batch_entries_work w ON w.entry_index = bl.entry_index AND w.status = 'claimed'
    UNION
    SELECT DISTINCT bl.credit_account_id
    FROM pg_temp.batch_lines_work bl
    JOIN pg_temp.batch_entries_work w ON w.entry_index = bl.entry_index AND w.status = 'claimed'
  )
    AND (a.debits_must_not_exceed_credits OR a.credits_must_not_exceed_debits);

  -- Aggregate lines per entry and account for limit evaluation
  CREATE TEMPORARY TABLE IF NOT EXISTS pg_temp.batch_entry_totals (
    entry_index integer NOT NULL,
    account_id  bigint NOT NULL,
    debit       bigint NOT NULL,
    credit      bigint NOT NULL,
    PRIMARY KEY (entry_index, account_id)
  ) ON COMMIT DELETE ROWS;
  DELETE FROM pg_temp.batch_entry_totals;

  INSERT INTO pg_temp.batch_entry_totals (entry_index, account_id, debit, credit)
  SELECT
    mov.entry_index,
    mov.account_id,
    sum(mov.debit)::bigint,
    sum(mov.credit)::bigint
  FROM (
    SELECT bl.entry_index, bl.debit_account_id AS account_id, bl.amount AS debit, 0::bigint AS credit
    FROM pg_temp.batch_lines_work bl
    JOIN pg_temp.batch_entries_work w ON w.entry_index = bl.entry_index AND w.status = 'claimed'
    UNION ALL
    SELECT bl.entry_index, bl.credit_account_id AS account_id, 0::bigint AS debit, bl.amount AS credit
    FROM pg_temp.batch_lines_work bl
    JOIN pg_temp.batch_entries_work w ON w.entry_index = bl.entry_index AND w.status = 'claimed'
  ) mov
  GROUP BY mov.entry_index, mov.account_id;

  -- Iterate through claimed entries in request order
  FOR v_cur_entry IN
    SELECT w.entry_index
    FROM pg_temp.batch_entries_work w
    WHERE w.status = 'claimed'
    ORDER BY w.entry_index
  LOOP
    v_entry_ok := true;

    FOR v_acct IN
      SELECT
        b.account_id,
        b.debits_must_not_exceed_credits,
        b.credits_must_not_exceed_debits,
        b.debits_pending,
        b.credits_pending,
        b.debits_posted,
        b.credits_posted,
        t.debit AS entry_debit,
        t.credit AS entry_credit
      FROM pg_temp.batch_entry_totals t
      JOIN pg_temp.batch_account_balances b ON b.account_id = t.account_id
      WHERE t.entry_index = v_cur_entry.entry_index
    LOOP
      IF account_limit_exceeded(
        v_acct.debits_must_not_exceed_credits,
        v_acct.credits_must_not_exceed_debits,
        v_acct.debits_pending,
        v_acct.credits_pending,
        v_acct.debits_posted,
        v_acct.credits_posted,
        v_acct.entry_debit,
        v_acct.entry_credit
      ) THEN
        v_entry_ok := false;
        EXIT;
      END IF;
    END LOOP;

    IF v_entry_ok THEN
      -- Update running balances
      UPDATE pg_temp.batch_account_balances b
      SET debits_posted = b.debits_posted + t.debit,
          credits_posted = b.credits_posted + t.credit
      FROM pg_temp.batch_entry_totals t
      WHERE t.entry_index = v_cur_entry.entry_index
        AND t.account_id = b.account_id;
    ELSE
      -- Reject this entry
      UPDATE pg_temp.batch_entries_work
      SET status = 'rejected',
          error_code = 'insufficient_funds',
          error_message = 'Insufficient funds.'
      WHERE entry_index = v_cur_entry.entry_index;
    END IF;
  END LOOP;

  -- 7. Release rejected request ids, then finalize accepted claims. No lines
  -- reference the provisional entry rows yet, so deleting rejected claims is
  -- cheap and leaves their idempotency keys reusable after commit.
  DELETE FROM journal_entries j
  USING pg_temp.batch_entries_work w
  WHERE w.status = 'rejected'
    AND w.entry_id = j.id;

  UPDATE pg_temp.batch_entries_work
  SET status = 'created'
  WHERE status = 'claimed';

  -- 8. Insert journal_lines for created entries
  INSERT INTO journal_lines (
    journal_entry_id,
    ledger_id,
    debit_account_id,
    credit_account_id,
    line_number,
    amount,
    effect,
    purpose
  )
  SELECT
    w.entry_id,
    v_ledger.id,
    bl.debit_account_id,
    bl.credit_account_id,
    bl.line_number,
    bl.amount,
    'posted',
    bl.purpose
  FROM pg_temp.batch_lines_work bl
  JOIN pg_temp.batch_entries_work w ON w.entry_index = bl.entry_index
  WHERE w.status = 'created'
  ORDER BY bl.entry_index, bl.line_number;

  -- 9. Insert account_movements for accounts recording movements
  WITH batch_movements_lines AS (
    SELECT
      bl.debit_account_id AS account_id,
      w.entry_id AS journal_entry_id,
      w.entry_index,
      bl.line_number,
      'debit'::text AS direction,
      bl.amount,
      -bl.amount AS signed_amount,
      bl.purpose
    FROM pg_temp.batch_lines_work bl
    JOIN pg_temp.batch_entries_work w ON w.entry_index = bl.entry_index
    JOIN accounts a ON a.id = bl.debit_account_id
    WHERE w.status = 'created'
      AND a.records_movements = true

    UNION ALL

    SELECT
      bl.credit_account_id AS account_id,
      w.entry_id AS journal_entry_id,
      w.entry_index,
      bl.line_number,
      'credit'::text AS direction,
      bl.amount,
      bl.amount AS signed_amount,
      bl.purpose
    FROM pg_temp.batch_lines_work bl
    JOIN pg_temp.batch_entries_work w ON w.entry_index = bl.entry_index
    JOIN accounts a ON a.id = bl.credit_account_id
    WHERE w.status = 'created'
      AND a.records_movements = true
  ),
  account_prev AS (
    SELECT
      a.id AS account_id,
      a.movement_count,
      coalesce(prev.balance_after, 0::bigint) AS prev_balance_after,
      greatest(clock_timestamp(), prev.recorded_at) AS recorded_at
    FROM accounts a
    LEFT JOIN account_movements prev
      ON prev.account_id = a.id
     AND prev.sequence = a.movement_count
    WHERE a.id IN (SELECT DISTINCT bml.account_id FROM batch_movements_lines bml)
  ),
  inserted_movements AS (
    INSERT INTO account_movements (
      account_id,
      sequence,
      journal_entry_id,
      line_number,
      direction,
      amount,
      purpose,
      balance_after,
      recorded_at
    )
    SELECT
      lines.account_id,
      prev.movement_count + row_number() OVER (
        PARTITION BY lines.account_id
        ORDER BY lines.entry_index, lines.line_number
      ) AS sequence,
      lines.journal_entry_id,
      lines.line_number,
      lines.direction,
      lines.amount,
      lines.purpose,
      prev.prev_balance_after + sum(lines.signed_amount) OVER (
        PARTITION BY lines.account_id
        ORDER BY lines.entry_index, lines.line_number
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
      ) AS balance_after,
      prev.recorded_at
    FROM batch_movements_lines lines
    JOIN account_prev prev ON prev.account_id = lines.account_id
    ORDER BY lines.account_id, lines.entry_index, lines.line_number
    RETURNING account_id
  ),
  movement_counts AS (
    SELECT im.account_id, count(*)::bigint AS cnt
    FROM inserted_movements im
    GROUP BY im.account_id
  ),
  batch_account_posted_totals AS (
    SELECT
      t.account_id,
      sum(t.debit)::bigint AS total_debit,
      sum(t.credit)::bigint AS total_credit
    FROM pg_temp.batch_entry_totals t
    JOIN pg_temp.batch_entries_work w ON w.entry_index = t.entry_index
    WHERE w.status = 'created'
    GROUP BY t.account_id
  )
  -- 10. Update tracked account counters once
  UPDATE accounts a
  SET debits_posted = a.debits_posted + coalesce(tot.total_debit, 0),
      credits_posted = a.credits_posted + coalesce(tot.total_credit, 0),
      movement_count = a.movement_count + coalesce(mc.cnt, 0)
  FROM batch_account_posted_totals tot
  LEFT JOIN movement_counts mc ON mc.account_id = tot.account_id
  WHERE a.id = tot.account_id
    AND a.tracks_balance;

  -- 11. Return results in request order
  RETURN QUERY
  SELECT
    w.entry_index AS out_entry_index,
    w.request_id AS out_request_id,
    w.status AS out_status,
    w.error_code AS out_error_code,
    w.error_message AS out_error_message,
    w.entry_id AS out_id,
    w.public_ref AS out_public_ref,
    v_ledger.id AS out_ledger_id,
    w.kind AS out_kind,
    -- Note: out_state is 'posted' and out_expires_at / out_pending_entry_id are NULL because
    -- this routine currently only posts immediate entries. When authorizations/pending entries
    -- and resolution routines are integrated, existing hits on authorizations will need to reflect
    -- the stored entry's actual state, expires_at, and pending_entry_id.
    'posted'::text AS out_state,
    w.description AS out_description,
    NULL::timestamp with time zone AS out_expires_at,
    NULL::bigint AS out_pending_entry_id,
    w.effective_at AS out_effective_at,
    w.created_at AS out_created_at
  FROM pg_temp.batch_entries_work w
  ORDER BY w.entry_index;

END $$;
-- +goose StatementEnd
