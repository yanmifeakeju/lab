-- +goose Up
-- Building blocks shared by post_entry() and post_entries(), then post_entry()
-- itself. The two routines are deliberately separate implementations: one fails
-- the whole call on the first problem, the other records an outcome per entry
-- without opening a subtransaction. What they must agree on lives here.

-- journal_entry_totals() aggregates one entry's lines by account. It never
-- scans an account's journal history; posting uses it to lock and update each
-- affected account exactly once.

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION journal_entry_totals(p_entry_id bigint)
RETURNS TABLE (
  account_id bigint,
  debit      bigint,
  credit     bigint
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT movement.account_id,
         sum(movement.debit)::bigint,
         sum(movement.credit)::bigint
  FROM (
    SELECT debit_account_id AS account_id, amount AS debit, 0::bigint AS credit
    FROM journal_lines
    WHERE journal_entry_id = p_entry_id

    UNION ALL

    SELECT credit_account_id AS account_id, 0::bigint AS debit, amount AS credit
    FROM journal_lines
    WHERE journal_entry_id = p_entry_id
  ) AS movement
  GROUP BY movement.account_id;
$$;
-- +goose StatementEnd

-- journal_fingerprint() identifies a posting request by its content, so a retry
-- through either endpoint is recognised as the same request. Both routines must
-- hash identically or an entry posted through one would look new to the other.
--
-- jsonb provides a stable object-key order and preserves line-array order. The
-- caller-supplied effective time is hashed before it is defaulted: otherwise
-- each retry that omitted the value would appear to contain new content.
--
-- STABLE, not IMMUTABLE, only because extract(epoch FROM timestamptz) is.

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION journal_fingerprint(
  p_ledger_slug  text,
  p_kind         text,
  p_description  text,
  p_effective_at timestamp with time zone,
  p_lines        jsonb
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
          'operation', 'post',
          'ledger_slug', p_ledger_slug,
          'kind', p_kind,
          'description', p_description,
          'effective_at_epoch', CASE
            WHEN p_effective_at IS NULL THEN NULL
            ELSE extract(epoch FROM p_effective_at)
          END,
          'lines', p_lines
        )::text,
        'UTF8'
      )
    ),
    'hex'
  );
$$;
-- +goose StatementEnd

-- account_limit_exceeded() answers whether adding a debit and a credit to an
-- account would break its overdraft limit. The counters are passed in rather
-- than read, because a batch checks entries against running balances held in
-- memory, not against the stored row.
--
-- It takes no search_path: it reads nothing, so leaving it inlinable matters
-- more. The same arithmetic is spelled out in the accounts CHECK constraints,
-- which cannot call it; those constraints remain the enforcement, this is the
-- pre-check that turns a violation into a domain error.

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION account_limit_exceeded(
  p_debits_must_not_exceed_credits boolean,
  p_credits_must_not_exceed_debits boolean,
  p_debits_pending                 bigint,
  p_credits_pending                bigint,
  p_debits_posted                  bigint,
  p_credits_posted                 bigint,
  p_added_debit                    bigint,
  p_added_credit                   bigint
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT (
    p_debits_must_not_exceed_credits
    AND p_debits_pending + p_debits_posted + p_added_debit
        > p_credits_posted + p_added_credit
  ) OR (
    p_credits_must_not_exceed_debits
    AND p_credits_pending + p_credits_posted + p_added_credit
        > p_debits_posted + p_added_debit
  );
$$;
-- +goose StatementEnd

-- post_entry() records one immediately posted entry, writes movements for
-- accounts that record them, and updates account counters atomically. It fails
-- the whole call on the first problem it finds.
--
--   LG001  ledger_not_found
--   LG002  ledger_closed
--   LG011  account_closed
--   LG020  idempotency_conflict
--   LG021  no_lines
--   LG022  account_not_found
--   LG024  insufficient_funds

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION post_entry(
  p_public_ref   text,
  p_ledger_slug  text,
  p_request_id   text,
  p_kind         text,
  p_description  text,
  p_effective_at timestamp with time zone,
  p_lines        jsonb
)
RETURNS TABLE (
  out_id               bigint,
  out_public_ref       text,
  out_ledger_id        integer,
  out_request_id       text,
  out_kind             text,
  out_state            text,
  out_description      text,
  out_expires_at       timestamp with time zone,
  out_pending_entry_id bigint,
  out_effective_at     timestamp with time zone,
  out_created_at       timestamp with time zone,
  out_created          boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ledger      ledgers%ROWTYPE;
  v_entry       journal_entries%ROWTYPE;
  v_existing    journal_entries%ROWTYPE;
  v_fingerprint text;
  v_resolved    integer;
  v_bad         integer;
BEGIN
  IF jsonb_typeof(p_lines) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'no_lines' USING ERRCODE = 'LG021';
  END IF;

  IF jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'no_lines' USING ERRCODE = 'LG021';
  END IF;

  SELECT * INTO v_ledger
  FROM ledgers
  WHERE slug = p_ledger_slug
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ledger_not_found: %', p_ledger_slug USING ERRCODE = 'LG001';
  END IF;

  v_fingerprint := journal_fingerprint(
    p_ledger_slug, p_kind, p_description, p_effective_at, p_lines
  );

  -- Return successful retries even if the ledger or an account was closed
  -- after the original post.
  SELECT * INTO v_existing
  FROM journal_entries
  WHERE ledger_id = v_ledger.id
    AND request_id = p_request_id;

  IF FOUND THEN
    IF v_existing.fingerprint <> v_fingerprint THEN
      RAISE EXCEPTION 'idempotency_conflict: %', p_request_id USING ERRCODE = 'LG020';
    END IF;

    RETURN QUERY
    SELECT v_existing.id, v_existing.public_ref, v_existing.ledger_id,
           v_existing.request_id, v_existing.kind, v_existing.state,
           v_existing.description, v_existing.expires_at,
           v_existing.pending_entry_id, v_existing.effective_at,
           v_existing.created_at, false;
    RETURN;
  END IF;

  IF v_ledger.is_closed THEN
    RAISE EXCEPTION 'ledger_closed: %', p_ledger_slug USING ERRCODE = 'LG002';
  END IF;

  -- Claim the request id before taking account locks. post_entries() claims
  -- request ids in the same phase and in sorted order, so idempotency and
  -- account locks never form a cycle. The loser of a concurrent first attempt
  -- waits here for the winner, then returns its entry.
  INSERT INTO journal_entries
    (public_ref, ledger_id, request_id, fingerprint, kind, state,
     description, effective_at)
  VALUES
    (p_public_ref, v_ledger.id, p_request_id, v_fingerprint, p_kind, 'posted',
     p_description, coalesce(p_effective_at, now()))
  ON CONFLICT (ledger_id, request_id) DO NOTHING
  RETURNING * INTO v_entry;

  IF NOT FOUND THEN
    SELECT * INTO v_existing
    FROM journal_entries
    WHERE ledger_id = v_ledger.id
      AND request_id = p_request_id;

    IF v_existing.fingerprint <> v_fingerprint THEN
      RAISE EXCEPTION 'idempotency_conflict: %', p_request_id USING ERRCODE = 'LG020';
    END IF;

    RETURN QUERY
    SELECT v_existing.id, v_existing.public_ref, v_existing.ledger_id,
           v_existing.request_id, v_existing.kind, v_existing.state,
           v_existing.description, v_existing.expires_at,
           v_existing.pending_entry_id, v_existing.effective_at,
           v_existing.created_at, false;
    RETURN;
  END IF;

  -- Only accounts that track a balance are locked. The others keep no
  -- counters, so postings to them run in parallel.
  --
  -- Every locked account is locked in the same order and before the lines are
  -- inserted: the line foreign keys take KEY SHARE locks on the accounts they
  -- reference, and locking afterwards would let two concurrent entries each
  -- hold KEY SHARE while waiting for the other's FOR UPDATE.
  PERFORM 1
  FROM accounts AS locked
  WHERE locked.id IN (
    SELECT affected.account_id
    FROM (
      SELECT debit.id AS account_id
      FROM jsonb_array_elements(p_lines) AS element
      JOIN accounts AS debit
        ON debit.public_ref = element->>'debit_account_ref'
       AND debit.ledger_id = v_ledger.id

      UNION

      SELECT credit.id AS account_id
      FROM jsonb_array_elements(p_lines) AS element
      JOIN accounts AS credit
        ON credit.public_ref = element->>'credit_account_ref'
       AND credit.ledger_id = v_ledger.id
    ) AS affected
  )
    AND locked.tracks_balance
  ORDER BY locked.id
  FOR UPDATE;

  WITH parsed AS (
    SELECT line_number::smallint AS line_number,
           element->>'debit_account_ref' AS debit_account_ref,
           element->>'credit_account_ref' AS credit_account_ref,
           (element->>'amount')::bigint AS amount,
           element->>'purpose' AS purpose
    FROM jsonb_array_elements(p_lines) WITH ORDINALITY
      AS supplied(element, line_number)
  ),
  resolved AS (
    SELECT parsed.line_number, debit.id AS debit_account_id,
           credit.id AS credit_account_id, parsed.amount, parsed.purpose
    FROM parsed
    JOIN accounts AS debit
      ON debit.public_ref = parsed.debit_account_ref
     AND debit.ledger_id = v_ledger.id
    JOIN accounts AS credit
      ON credit.public_ref = parsed.credit_account_ref
     AND credit.ledger_id = v_ledger.id
  )
  INSERT INTO journal_lines
    (journal_entry_id, ledger_id, debit_account_id, credit_account_id,
     line_number, amount, effect, purpose)
  SELECT v_entry.id, v_ledger.id, resolved.debit_account_id,
         resolved.credit_account_id, resolved.line_number, resolved.amount,
         'posted', resolved.purpose
  FROM resolved
  ORDER BY resolved.line_number;

  GET DIAGNOSTICS v_resolved = ROW_COUNT;
  IF v_resolved <> jsonb_array_length(p_lines) THEN
    RAISE EXCEPTION 'account_not_found' USING ERRCODE = 'LG022';
  END IF;

  SELECT count(*) INTO v_bad
  FROM journal_entry_totals(v_entry.id) AS total
  JOIN accounts AS account ON account.id = total.account_id
  WHERE account.closed_at IS NOT NULL
    AND account.closed_at <= clock_timestamp();

  IF v_bad > 0 THEN
    RAISE EXCEPTION 'account_closed' USING ERRCODE = 'LG011';
  END IF;

  -- Check the intended values before updating so callers receive a stable
  -- domain error instead of a generic CHECK-constraint violation.
  SELECT count(*) INTO v_bad
  FROM journal_entry_totals(v_entry.id) AS total
  JOIN accounts AS account ON account.id = total.account_id
  WHERE account_limit_exceeded(
    account.debits_must_not_exceed_credits,
    account.credits_must_not_exceed_debits,
    account.debits_pending,
    account.credits_pending,
    account.debits_posted,
    account.credits_posted,
    total.debit,
    total.credit
  );

  IF v_bad > 0 THEN
    RAISE EXCEPTION 'insufficient_funds' USING ERRCODE = 'LG024';
  END IF;

  -- For each affected account that records movements, write running-balance movements
  -- and update movement_count alongside balance counters.
  WITH entry_account_lines AS (
    SELECT
      line.debit_account_id AS account_id,
      line.journal_entry_id,
      line.line_number,
      'debit'::text AS direction,
      line.amount,
      -line.amount AS signed_amount,
      line.purpose
    FROM journal_lines line
    JOIN accounts a ON a.id = line.debit_account_id
    WHERE line.journal_entry_id = v_entry.id
      AND a.records_movements = true

    UNION ALL

    SELECT
      line.credit_account_id AS account_id,
      line.journal_entry_id,
      line.line_number,
      'credit'::text AS direction,
      line.amount,
      line.amount AS signed_amount,
      line.purpose
    FROM journal_lines line
    JOIN accounts a ON a.id = line.credit_account_id
    WHERE line.journal_entry_id = v_entry.id
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
    WHERE a.id IN (SELECT DISTINCT account_id FROM entry_account_lines)
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
        ORDER BY lines.line_number
      ) AS sequence,
      lines.journal_entry_id,
      lines.line_number,
      lines.direction,
      lines.amount,
      lines.purpose,
      prev.prev_balance_after + sum(lines.signed_amount) OVER (
        PARTITION BY lines.account_id
        ORDER BY lines.line_number
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
      ) AS balance_after,
      prev.recorded_at
    FROM entry_account_lines lines
    JOIN account_prev prev ON prev.account_id = lines.account_id
    ORDER BY lines.account_id, lines.line_number
    RETURNING account_id
  ),
  movement_counts AS (
    SELECT account_id, count(*)::bigint AS cnt
    FROM inserted_movements
    GROUP BY account_id
  )
  UPDATE accounts AS account
  SET debits_posted = account.debits_posted + total.debit,
      credits_posted = account.credits_posted + total.credit,
      movement_count = account.movement_count + coalesce(mc.cnt, 0)
  FROM journal_entry_totals(v_entry.id) AS total
  LEFT JOIN movement_counts mc ON mc.account_id = total.account_id
  WHERE account.id = total.account_id
    AND account.tracks_balance;

  RETURN QUERY
  SELECT v_entry.id, v_entry.public_ref, v_entry.ledger_id,
         v_entry.request_id, v_entry.kind, v_entry.state,
         v_entry.description, v_entry.expires_at, v_entry.pending_entry_id,
         v_entry.effective_at, v_entry.created_at, true;
END $$;
-- +goose StatementEnd
