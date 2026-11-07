//go:build integration

package postgres_test

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"paytty.akeju.me/ledger/internal/journal"
	"paytty.akeju.me/ledger/internal/postgres"
	"paytty.akeju.me/ledger/internal/statement"
)

// fund credits the payable account with posted money a hold can draw on.
func (f postEntryFixture) fund(t *testing.T, amount int64) {
	t.Helper()
	f.mustPost(t, journal.PostInput{
		LedgerSlug:  f.slug,
		RequestID:   fmt.Sprintf("fund_%d", amount),
		Kind:        "payment",
		Description: "Payment received",
		Lines: []journal.LineInput{{
			DebitAccountReference:  f.platform.Cash.Reference,
			CreditAccountReference: f.payable.Reference,
			Amount:                 amount,
			Purpose:                "Card payment",
		}},
	})
}

func payoutHold(slug, requestID, payable, cash string, amount int64) journal.PostInput {
	return journal.PostInput{
		LedgerSlug:  slug,
		RequestID:   requestID,
		Kind:        "payout",
		Description: "Payout to GTBank 6789",
		Lines: []journal.LineInput{{
			DebitAccountReference:  payable,
			CreditAccountReference: cash,
			Amount:                 amount,
			Purpose:                "payout",
		}},
		Pending: true,
	}
}

func (f postEntryFixture) hold(t *testing.T, requestID string, amount int64) journal.PostResult {
	t.Helper()
	return f.mustPost(t, payoutHold(f.slug, requestID, f.payable.Reference, f.platform.Cash.Reference, amount))
}

func (f postEntryFixture) mustResolve(t *testing.T, requestID, pendingRef string, action journal.Action) journal.ResolveResult {
	t.Helper()
	result, err := f.store.ResolveEntry(t.Context(), journal.ResolveInput{
		LedgerSlug:       f.slug,
		RequestID:        requestID,
		PendingReference: pendingRef,
		Action:           action,
	})
	if err != nil {
		t.Fatalf("ResolveEntry(%s, %s) error = %v", pendingRef, action, err)
	}
	return result
}

type authorizationRow struct {
	State      string
	Resolution sql.NullString
	ResolvedAt bool
}

func readAuthorization(t *testing.T, db postgres.DBTX, entryRef string) (authorizationRow, bool) {
	t.Helper()
	var row authorizationRow
	err := db.QueryRowContext(t.Context(), `
		SELECT auth.state, resolution.public_ref, auth.resolved_at IS NOT NULL
		FROM authorizations auth
		JOIN journal_entries entry ON entry.id = auth.entry_id
		LEFT JOIN journal_entries resolution ON resolution.id = auth.resolution_entry_id
		WHERE entry.public_ref = $1`, entryRef,
	).Scan(&row.State, &row.Resolution, &row.ResolvedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return row, false
	}
	if err != nil {
		t.Fatalf("read authorization of %s: %v", entryRef, err)
	}
	return row, true
}

func TestStore_PendingHold_Capture(t *testing.T) {
	f := newPostEntryFixture(t)
	f.fund(t, 10_000)

	hold := f.hold(t, "hold_1", 4_000)
	if !hold.Created || hold.Entry.State != journal.StatePending {
		t.Fatalf("hold = (created %t, state %q), want (true, pending)", hold.Created, hold.Entry.State)
	}
	assertJournalLines(t, f.tx, hold.Entry.Reference, []journalLineRow{{
		LedgerID: f.ledgerID, Amount: 4_000, DebitAccountID: f.payable.ID,
		CreditAccountID: f.platform.Cash.ID, LineNumber: 1, Effect: "pending", Purpose: "payout",
	}})
	if got := readAccountBalances(t, f.tx, f.payable.ID); got != (accountBalances{DebitsPending: 4_000, CreditsPosted: 10_000}) {
		t.Errorf("payable after hold = %+v", got)
	}
	// A hold writes no movement.
	assertAccountMovements(t, f.tx, f.payable.ID, []accountMovementRow{
		{Sequence: 1, LineNumber: 1, Direction: "credit", Amount: 10_000, Purpose: "Card payment", BalanceAfter: 10_000},
	})

	capture := f.mustResolve(t, "capture_1", hold.Entry.Reference, journal.ActionCapture)
	r := capture.Resolution
	if !capture.Created || r.State != journal.StateCaptured || r.PendingReference != hold.Entry.Reference {
		t.Errorf("capture = %+v (created %t)", r, capture.Created)
	}
	if r.Kind != "payout" || r.Description != "Payout to GTBank 6789" {
		t.Errorf("capture copied kind %q description %q", r.Kind, r.Description)
	}
	assertJournalLines(t, f.tx, r.Reference, []journalLineRow{{
		LedgerID: f.ledgerID, Amount: 4_000, DebitAccountID: f.payable.ID,
		CreditAccountID: f.platform.Cash.ID, LineNumber: 1, Effect: "pending_posted", Purpose: "payout",
	}})
	if got := readAccountBalances(t, f.tx, f.payable.ID); got != (accountBalances{DebitsPosted: 4_000, CreditsPosted: 10_000}) {
		t.Errorf("payable after capture = %+v", got)
	}
	assertAccountMovements(t, f.tx, f.payable.ID, []accountMovementRow{
		{Sequence: 1, LineNumber: 1, Direction: "credit", Amount: 10_000, Purpose: "Card payment", BalanceAfter: 10_000},
		{Sequence: 2, LineNumber: 1, Direction: "debit", Amount: 4_000, Purpose: "payout", BalanceAfter: 6_000},
	})

	auth, ok := readAuthorization(t, f.tx, hold.Entry.Reference)
	if !ok || auth.State != "captured" || auth.Resolution.String != r.Reference || !auth.ResolvedAt {
		t.Errorf("authorization = %+v (found %t), want captured by %s", auth, ok, r.Reference)
	}

	res, err := postgres.NewWithStatementMargin(f.tx, 0).GetStatement(t.Context(), statement.ListInput{
		AccountReference: f.payable.Reference,
		From:             new(time.Now().Add(-time.Hour)),
		To:               new(time.Now().Add(time.Hour)),
		Limit:            50,
	})
	if err != nil {
		t.Fatalf("GetStatement() error = %v", err)
	}
	if res.ClosingBalance != 6_000 || len(res.Movements) != 2 || res.Movements[1].JournalReference != r.Reference {
		t.Errorf("statement closing %d, %d movements, want 6000 and the capture last", res.ClosingBalance, len(res.Movements))
	}

	// A replay of the hold reports its state now.
	replay := f.hold(t, "hold_1", 4_000)
	if replay.Created || replay.Entry.State != journal.StateCaptured || replay.Entry.Reference != hold.Entry.Reference {
		t.Errorf("hold replay = (created %t, state %q)", replay.Created, replay.Entry.State)
	}
	again := f.mustResolve(t, "capture_1", hold.Entry.Reference, journal.ActionCapture)
	if again.Created || again.Resolution.Reference != r.Reference || again.Resolution.State != journal.StateCaptured {
		t.Errorf("capture replay = %+v (created %t)", again.Resolution, again.Created)
	}
}

func TestStore_PendingHold_Void(t *testing.T) {
	f := newPostEntryFixture(t)
	f.fund(t, 10_000)

	hold := f.hold(t, "hold_1", 4_000)
	void := f.mustResolve(t, "void_1", hold.Entry.Reference, journal.ActionVoid)
	if void.Resolution.State != journal.StateVoided {
		t.Errorf("void state = %q", void.Resolution.State)
	}
	assertJournalLines(t, f.tx, void.Resolution.Reference, []journalLineRow{{
		LedgerID: f.ledgerID, Amount: 4_000, DebitAccountID: f.payable.ID,
		CreditAccountID: f.platform.Cash.ID, LineNumber: 1, Effect: "pending_voided", Purpose: "payout",
	}})
	if got := readAccountBalances(t, f.tx, f.payable.ID); got != (accountBalances{CreditsPosted: 10_000}) {
		t.Errorf("payable after void = %+v", got)
	}
	assertAccountMovements(t, f.tx, f.payable.ID, []accountMovementRow{
		{Sequence: 1, LineNumber: 1, Direction: "credit", Amount: 10_000, Purpose: "Card payment", BalanceAfter: 10_000},
	})
}

func TestStore_PendingHold_InsufficientFunds(t *testing.T) {
	f := newPostEntryFixture(t)
	f.fund(t, 10_000)
	f.hold(t, "hold_1", 6_000)

	err := runWithRollbackSavepoint(t, f.tx, func() error {
		_, err := f.store.PostEntry(t.Context(), payoutHold(f.slug, "hold_2", f.payable.Reference, f.platform.Cash.Reference, 5_000))
		return err
	})
	if !errors.Is(err, journal.ErrInsufficientFunds) {
		t.Fatalf("second hold error = %v, want insufficient funds", err)
	}
	assertNoJournalEntry(t, f.tx, f.ledgerID, "hold_2")
	var count int
	if err := f.tx.QueryRowContext(t.Context(), `SELECT count(*) FROM authorizations WHERE ledger_id = $1`, f.ledgerID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Errorf("authorizations = %d, want 1", count)
	}
}

// TestStore_PendingCredit_NotSpendable verifies an incoming pending credit is
// recorded but cannot fund a debit until captured.
func TestStore_PendingCredit_NotSpendable(t *testing.T) {
	f := newPostEntryFixture(t)
	incoming := f.mustPost(t, journal.PostInput{
		LedgerSlug: f.slug, RequestID: "in_1", Kind: "payment", Description: "Payment received",
		Lines: []journal.LineInput{{
			DebitAccountReference: f.platform.Cash.Reference, CreditAccountReference: f.payable.Reference,
			Amount: 5_000, Purpose: "Card payment",
		}},
		Pending: true,
	})
	if incoming.Entry.State != journal.StatePending {
		t.Errorf("incoming state = %q, want pending", incoming.Entry.State)
	}
	if got := readAccountBalances(t, f.tx, f.payable.ID); got != (accountBalances{CreditsPending: 5_000}) {
		t.Errorf("payable = %+v", got)
	}

	err := runWithRollbackSavepoint(t, f.tx, func() error {
		_, err := f.store.PostEntry(t.Context(), payoutHold(f.slug, "hold_1", f.payable.Reference, f.platform.Cash.Reference, 1))
		return err
	})
	if !errors.Is(err, journal.ErrInsufficientFunds) {
		t.Fatalf("hold against pending credit error = %v, want insufficient funds", err)
	}

	f.mustResolve(t, "settle_1", incoming.Entry.Reference, journal.ActionCapture)
	f.hold(t, "hold_1", 5_000)
}

func TestStore_ResolveEntry_Errors(t *testing.T) {
	f := newPostEntryFixture(t)
	f.fund(t, 10_000)
	hold := f.hold(t, "hold_1", 1_000)
	immediate := f.mustPost(t, journal.PostInput{
		LedgerSlug: f.slug, RequestID: "imm_1", Kind: "payment", Description: "Payment received",
		Lines: []journal.LineInput{{
			DebitAccountReference: f.platform.Cash.Reference, CreditAccountReference: f.payable.Reference,
			Amount: 1, Purpose: "Card payment",
		}},
	})

	resolve := func(key, ref string, action journal.Action) error {
		return runWithRollbackSavepoint(t, f.tx, func() error {
			_, err := f.store.ResolveEntry(t.Context(), journal.ResolveInput{
				LedgerSlug: f.slug, RequestID: key, PendingReference: ref, Action: action,
			})
			return err
		})
	}

	if err := resolve("r1", "jrn_01K33YW0MDHJ9E4N7Z2QPV6R8K", journal.ActionCapture); !errors.Is(err, journal.ErrEntryNotFound) {
		t.Errorf("unknown ref error = %v, want entry not found", err)
	}
	if err := resolve("r2", immediate.Entry.Reference, journal.ActionCapture); !errors.Is(err, journal.ErrEntryNotPending) {
		t.Errorf("immediate entry error = %v, want entry not pending", err)
	}
	if err := resolve("hold_1", hold.Entry.Reference, journal.ActionCapture); !errors.Is(err, journal.ErrIdempotencyConflict) {
		t.Errorf("key reused from a post error = %v, want idempotency conflict", err)
	}
	if err := runWithRollbackSavepoint(t, f.tx, func() error {
		_, err := f.store.ResolveEntry(t.Context(), journal.ResolveInput{
			LedgerSlug: "usd_us", RequestID: "r6", PendingReference: hold.Entry.Reference, Action: journal.ActionVoid,
		})
		return err
	}); !errors.Is(err, journal.ErrLedgerNotFound) {
		t.Errorf("unknown ledger error = %v, want ledger not found", err)
	}

	void := f.mustResolve(t, "r4", hold.Entry.Reference, journal.ActionVoid)
	err := resolve("r5", hold.Entry.Reference, journal.ActionCapture)
	var resolved *journal.ResolvedError
	if !errors.As(err, &resolved) || !errors.Is(err, journal.ErrEntryResolved) {
		t.Fatalf("second resolution error = %v, want entry resolved", err)
	}
	if resolved.State != journal.StateVoided || resolved.ResolutionReference != void.Resolution.Reference {
		t.Errorf("winner = %+v, want voided by %s", resolved, void.Resolution.Reference)
	}
}

// TestJournalFingerprint_ImmediateUnchanged verifies the pending keys leave an
// immediate entry's fingerprint exactly as the original formula computed it.
func TestJournalFingerprint_ImmediateUnchanged(t *testing.T) {
	tx := newTestTx(t)
	var same bool
	err := tx.QueryRowContext(t.Context(), `
		WITH args AS (
			SELECT 'ngn_ng'::text AS slug, 'payment'::text AS kind, 'Paid'::text AS description,
			       '2026-08-20T10:30:00Z'::timestamptz AS effective_at,
			       '[{"amount": 1, "purpose": "p"}]'::jsonb AS lines
		)
		SELECT journal_fingerprint(slug, kind, description, effective_at, lines, false)
		     = encode(sha256(convert_to(jsonb_build_object(
		         'operation', 'post', 'ledger_slug', slug, 'kind', kind,
		         'description', description,
		         'effective_at_epoch', extract(epoch FROM effective_at),
		         'lines', lines)::text, 'UTF8')), 'hex')
		FROM args`).Scan(&same)
	if err != nil {
		t.Fatal(err)
	}
	if !same {
		t.Error("immediate fingerprint changed")
	}
}

func TestAuthorizations_Constraints(t *testing.T) {
	f := newPostEntryFixture(t)
	f.fund(t, 10_000)
	hold := f.hold(t, "hold_1", 100)
	other := f.hold(t, "hold_2", 100)

	for name, query := range map[string]string{
		"pending with resolution": `UPDATE authorizations SET resolution_entry_id = (SELECT id FROM journal_entries WHERE public_ref = $2), resolved_at = now() WHERE entry_id = (SELECT id FROM journal_entries WHERE public_ref = $1)`,
		"resolved without one":    `UPDATE authorizations SET state = 'captured' WHERE entry_id = (SELECT id FROM journal_entries WHERE public_ref = $1) AND $2::text IS NOT NULL`,
		"expired is not a state":  `UPDATE authorizations SET state = 'expired', resolution_entry_id = (SELECT id FROM journal_entries WHERE public_ref = $2), resolved_at = now() WHERE entry_id = (SELECT id FROM journal_entries WHERE public_ref = $1)`,
	} {
		err := runWithRollbackSavepoint(t, f.tx, func() error {
			_, err := f.tx.ExecContext(t.Context(), query, hold.Entry.Reference, other.Entry.Reference)
			return err
		})
		if err == nil || !strings.Contains(err.Error(), "23514") {
			t.Errorf("%s: error = %v, want CHECK violation", name, err)
		}
	}
}

// holdCommitted posts a hold in its own committed transaction.
func (f committedPostEntryFixture) holdCommitted(t *testing.T, ctx context.Context, key string, amount int64) journal.PostResult {
	t.Helper()
	return f.mustPostCommitted(t, ctx, payoutHold(f.slug, key, f.payable.Reference, f.platform.Cash.Reference, amount))
}

func TestStore_PendingHold_ConcurrentHoldsShareFunds(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	f := newCommittedPostEntryFixture(t)
	f.mustPostCommitted(t, ctx, journal.PostInput{
		LedgerSlug: f.slug, RequestID: "fund", Kind: "payment", Description: "Payment received",
		Lines: []journal.LineInput{{
			DebitAccountReference: f.platform.Cash.Reference, CreditAccountReference: f.payable.Reference,
			Amount: 10_000, Purpose: "Card payment",
		}},
	})

	tx1, _ := testDB.BeginTx(ctx, nil)
	tx2, _ := testDB.BeginTx(ctx, nil)
	defer func() { _ = tx1.Rollback(); _ = tx2.Rollback() }()

	first, second := postOverlapping(t, ctx,
		tx1, payoutHold(f.slug, "hold_a", f.payable.Reference, f.platform.Cash.Reference, 6_000),
		tx2, payoutHold(f.slug, "hold_b", f.payable.Reference, f.platform.Cash.Reference, 6_000),
	)
	if first.Entry.State != journal.StatePending {
		t.Errorf("first hold state = %q", first.Entry.State)
	}
	if !errors.Is(second.err, journal.ErrInsufficientFunds) {
		t.Errorf("second hold error = %v, want insufficient funds", second.err)
	}
	if got := readAccountBalances(t, testDB, f.payable.ID); got != (accountBalances{DebitsPending: 6_000, CreditsPosted: 10_000}) {
		t.Errorf("payable = %+v", got)
	}
}

// resolveOverlapping holds tx1's resolution uncommitted until tx2's is seen
// waiting on a lock, then commits tx1.
func resolveOverlapping(
	t *testing.T,
	ctx context.Context,
	tx1 *sql.Tx, first journal.ResolveInput,
	tx2 *sql.Tx, second journal.ResolveInput,
) (journal.ResolveResult, error) {
	t.Helper()

	var pid int
	if err := tx2.QueryRowContext(ctx, `SELECT pg_backend_pid()`).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	if _, err := postgres.New(tx1).ResolveEntry(ctx, first); err != nil {
		t.Fatalf("first ResolveEntry() error = %v", err)
	}

	type outcome struct {
		result journal.ResolveResult
		err    error
	}
	done := make(chan outcome, 1)
	go func() {
		r, err := postgres.New(tx2).ResolveEntry(ctx, second)
		done <- outcome{r, err}
	}()

	waiting := make(chan struct{})
	go func() {
		ticker := time.NewTicker(5 * time.Millisecond)
		defer ticker.Stop()
		for range ticker.C {
			var wait sql.NullString
			if err := testDB.QueryRowContext(ctx, `SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1`, pid).Scan(&wait); err != nil || ctx.Err() != nil {
				close(waiting)
				return
			}
			if wait.String == "Lock" {
				close(waiting)
				return
			}
		}
	}()
	<-waiting

	if err := tx1.Commit(); err != nil {
		t.Fatalf("commit first: %v", err)
	}
	got := <-done
	if got.err == nil {
		if err := tx2.Commit(); err != nil {
			t.Fatalf("commit second: %v", err)
		}
	}
	return got.result, got.err
}

func TestStore_ResolveEntry_ConcurrentCaptureAndVoid(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	f := newCommittedPostEntryFixture(t)
	f.mustPostCommitted(t, ctx, journal.PostInput{
		LedgerSlug: f.slug, RequestID: "fund", Kind: "payment", Description: "Payment received",
		Lines: []journal.LineInput{{
			DebitAccountReference: f.platform.Cash.Reference, CreditAccountReference: f.payable.Reference,
			Amount: 10_000, Purpose: "Card payment",
		}},
	})
	hold := f.holdCommitted(t, ctx, "hold", 4_000)

	tx1, _ := testDB.BeginTx(ctx, nil)
	tx2, _ := testDB.BeginTx(ctx, nil)
	defer func() { _ = tx1.Rollback(); _ = tx2.Rollback() }()

	_, err := resolveOverlapping(t, ctx,
		tx1, journal.ResolveInput{LedgerSlug: f.slug, RequestID: "capture", PendingReference: hold.Entry.Reference, Action: journal.ActionCapture},
		tx2, journal.ResolveInput{LedgerSlug: f.slug, RequestID: "void", PendingReference: hold.Entry.Reference, Action: journal.ActionVoid},
	)
	var resolved *journal.ResolvedError
	if !errors.As(err, &resolved) || resolved.State != journal.StateCaptured {
		t.Fatalf("void after capture error = %v, want entry resolved (captured)", err)
	}

	var winner string
	if err := testDB.QueryRowContext(ctx, `SELECT public_ref FROM journal_entries WHERE ledger_id = $1 AND request_id = 'capture'`, f.ledgerID).Scan(&winner); err != nil {
		t.Fatal(err)
	}
	if resolved.ResolutionReference != winner {
		t.Errorf("winner = %s, want %s", resolved.ResolutionReference, winner)
	}
	var resolutions int
	if err := testDB.QueryRowContext(ctx, `SELECT count(*) FROM journal_entries WHERE ledger_id = $1 AND request_id IN ('capture', 'void')`, f.ledgerID).Scan(&resolutions); err != nil {
		t.Fatal(err)
	}
	if resolutions != 1 {
		t.Errorf("resolution entries = %d, want 1", resolutions)
	}
	if got := readAccountBalances(t, testDB, f.payable.ID); got != (accountBalances{DebitsPosted: 4_000, CreditsPosted: 10_000}) {
		t.Errorf("payable = %+v", got)
	}
}

func TestJournal_AppendOnly(t *testing.T) {
	f := newPostEntryFixture(t)
	f.fund(t, 100)

	for name, query := range map[string]string{
		"entry": `UPDATE journal_entries SET description = 'Edited' WHERE ledger_id = $1`,
		"line":  `UPDATE journal_lines SET amount = 1 WHERE ledger_id = $1`,
	} {
		err := runWithRollbackSavepoint(t, f.tx, func() error {
			_, err := f.tx.ExecContext(t.Context(), query, f.ledgerID)
			return err
		})
		if err == nil || !strings.Contains(err.Error(), "append-only") {
			t.Errorf("%s update error = %v, want append-only", name, err)
		}
	}
}

// TestStore_PostEntry_PendingIsPartOfTheRequest verifies a key reused with the
// same lines but a different mode is a conflict, not a replay.
func TestStore_PostEntry_PendingIsPartOfTheRequest(t *testing.T) {
	f := newPostEntryFixture(t)
	f.fund(t, 10_000)
	f.hold(t, "h_1", 100)

	immediate := payoutHold(f.slug, "h_1", f.payable.Reference, f.platform.Cash.Reference, 100)
	immediate.Pending = false
	err := runWithRollbackSavepoint(t, f.tx, func() error {
		_, err := f.store.PostEntry(t.Context(), immediate)
		return err
	})
	if !errors.Is(err, journal.ErrIdempotencyConflict) {
		t.Errorf("immediate retry of a pending key error = %v, want idempotency conflict", err)
	}
}
