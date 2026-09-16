//go:build integration

package postgres_test

import (
	"context"
	"database/sql"
	"errors"
	"testing"
	"time"

	"github.com/oklog/ulid/v2"

	"yanmifeakeju.com/ledger/internal/account"
	"yanmifeakeju.com/ledger/internal/journal"
	"yanmifeakeju.com/ledger/internal/postgres"
)

// TestStore_PostEntry_ConcurrentIdempotentRetry verifies the ON CONFLICT path
// under real concurrency. It runs PostEntry through two stores backed by
// separate connections, holding the first posting transaction uncommitted
// while the second waits on the conflict. Both calls must succeed and exactly
// one posting must be recorded.
func TestStore_PostEntry_ConcurrentIdempotentRetry(t *testing.T) {
	// A short deadline makes a locking regression fail fast instead of
	// hanging on the blocked call.
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	fixture := newCommittedPostEntryFixture(t)

	description := "Payment retry"
	effectiveAt := time.Date(2026, time.August, 20, 10, 30, 0, 0, time.UTC)
	const (
		amount int64 = 50_000
		fee    int64 = 500
	)
	input := journal.PostInput{
		LedgerSlug:  fixture.slug,
		RequestID:   "request_1",
		Kind:        "payment",
		Description: description,
		EffectiveAt: &effectiveAt,
		Lines: []journal.LineInput{
			{
				DebitAccountReference:  fixture.platform.Cash.Reference,
				CreditAccountReference: fixture.payable.Reference,
				Amount:                 amount,
				Purpose:                "Card payment",
			},
			{
				DebitAccountReference:  fixture.payable.Reference,
				CreditAccountReference: fixture.platform.FeeRevenue.Reference,
				Amount:                 fee,
				Purpose:                "Processing fee",
			},
		},
	}

	accountIDs := []int64{
		fixture.platform.Cash.ID,
		fixture.platform.FeeRevenue.ID,
		fixture.payable.ID,
	}
	before := make(map[int64]accountBalances, len(accountIDs))
	for _, id := range accountIDs {
		before[id] = readAccountBalances(t, testDB, id)
	}

	tx1, err := testDB.BeginTx(ctx, nil)
	if err != nil {
		t.Fatalf("begin first transaction: %v", err)
	}

	tx2, err := testDB.BeginTx(ctx, nil)
	if err != nil {
		_ = tx1.Rollback()
		t.Fatalf("begin second transaction: %v", err)
	}
	defer func() {
		// Release tx1's locks before rolling back a potentially blocked tx2.
		_ = tx1.Rollback()
		_ = tx2.Rollback()
	}()

	first, second := postOverlapping(t, ctx, tx1, input, tx2, input)

	if !first.Created {
		t.Error("first PostEntry() Created = false, want true")
	}
	if second.err != nil {
		t.Fatalf("second PostEntry() error = %v", second.err)
	}
	if second.result.Created {
		t.Error("second PostEntry() Created = true, want false")
	}

	if first.Entry.Reference != second.result.Entry.Reference {
		t.Errorf(
			"entries differ: %s vs %s",
			first.Entry.Reference, second.result.Entry.Reference,
		)
	}
	if first.Entry.State != journal.StatePosted {
		t.Errorf("entry state = %q, want %q", first.Entry.State, journal.StatePosted)
	}

	var entryCount int
	if err := testDB.QueryRowContext(
		ctx,
		`SELECT count(*) FROM journal_entries WHERE ledger_id = $1 AND request_id = $2`,
		fixture.ledgerID, input.RequestID,
	).Scan(&entryCount); err != nil {
		t.Fatalf("count journal entries: %v", err)
	}
	if entryCount != 1 {
		t.Errorf("journal entry count = %d, want 1", entryCount)
	}

	var lineCount int
	if err := testDB.QueryRowContext(
		ctx,
		`SELECT count(*) FROM journal_lines WHERE ledger_id = $1`,
		fixture.ledgerID,
	).Scan(&lineCount); err != nil {
		t.Fatalf("count journal lines: %v", err)
	}
	if lineCount != len(input.Lines) {
		t.Errorf("journal line count = %d, want %d", lineCount, len(input.Lines))
	}

	deltas := map[int64]accountBalances{
		fixture.platform.Cash.ID:       {DebitsPosted: amount},
		fixture.platform.FeeRevenue.ID: {CreditsPosted: fee},
		fixture.payable.ID:             {DebitsPosted: fee, CreditsPosted: amount},
	}
	for id, delta := range deltas {
		want := accountBalances{
			DebitsPending:  before[id].DebitsPending,
			CreditsPending: before[id].CreditsPending,
			DebitsPosted:   before[id].DebitsPosted + delta.DebitsPosted,
			CreditsPosted:  before[id].CreditsPosted + delta.CreditsPosted,
		}
		if got := readAccountBalances(t, testDB, id); got != want {
			t.Errorf("account %d balances = %+v, want %+v", id, got, want)
		}
	}
}

// TestStore_PostEntry_ConcurrentInsufficientFunds verifies that account-row
// locking prevents concurrent requests from overspending a restricted account.
func TestStore_PostEntry_ConcurrentInsufficientFunds(t *testing.T) {
	// Seed a restricted account with enough capacity for only one of two
	// requests. Hold the first posting transaction uncommitted while the second
	// waits on its account locks. Once the first commits, the second must return
	// journal.ErrInsufficientFunds.
	// A short deadline makes a locking regression fail fast instead of hanging
	// on the blocked call.
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	fixture := newCommittedPostEntryFixture(t)

	// Fund the payable account with exactly one request's worth of spend.
	const spend int64 = 50_000
	fixture.mustPostCommitted(t, ctx, journal.PostInput{
		LedgerSlug:  fixture.slug,
		RequestID:   "request_fund",
		Kind:        "payment",
		Description: "Funding payable account",
		Lines: []journal.LineInput{{
			DebitAccountReference:  fixture.platform.Cash.Reference,
			CreditAccountReference: fixture.payable.Reference,
			Amount:                 spend,
			Purpose:                "Funding",
		}},
	})

	spendInput := func(requestID string) journal.PostInput {
		return journal.PostInput{
			LedgerSlug:  fixture.slug,
			RequestID:   requestID,
			Kind:        "transfer",
			Description: "Spending from payable",
			Lines: []journal.LineInput{{
				DebitAccountReference:  fixture.payable.Reference,
				CreditAccountReference: fixture.platform.FeeRevenue.Reference,
				Amount:                 spend,
				Purpose:                "Fee payment",
			}},
		}
	}
	inputs := []journal.PostInput{spendInput("request_a"), spendInput("request_b")}

	accountIDs := []int64{
		fixture.platform.Cash.ID,
		fixture.platform.FeeRevenue.ID,
		fixture.payable.ID,
	}
	before := make(map[int64]accountBalances, len(accountIDs))
	for _, id := range accountIDs {
		before[id] = readAccountBalances(t, testDB, id)
	}

	tx1, err := testDB.BeginTx(ctx, nil)
	if err != nil {
		t.Fatalf("begin first transaction: %v", err)
	}

	tx2, err := testDB.BeginTx(ctx, nil)
	if err != nil {
		_ = tx1.Rollback()
		t.Fatalf("begin second transaction: %v", err)
	}
	defer func() {
		// Release tx1's locks before rolling back a potentially blocked tx2.
		_ = tx1.Rollback()
		_ = tx2.Rollback()
	}()

	first, second := postOverlapping(t, ctx, tx1, inputs[0], tx2, inputs[1])

	if !first.Created {
		t.Error("first PostEntry() Created = false, want true")
	}
	if !errors.Is(second.err, journal.ErrInsufficientFunds) {
		t.Fatalf(
			"second PostEntry() err = %v, want %v",
			second.err, journal.ErrInsufficientFunds,
		)
	}

	winnerEntry := first.Entry
	if winnerEntry.State != journal.StatePosted {
		t.Errorf("winner entry state = %q, want %q", winnerEntry.State, journal.StatePosted)
	}

	winnerRequest := inputs[0].RequestID
	loserRequest := inputs[1].RequestID

	var winnerEntries, loserEntries int
	if err := testDB.QueryRowContext(
		ctx,
		`SELECT count(*) FROM journal_entries WHERE ledger_id = $1 AND request_id = $2`,
		fixture.ledgerID, winnerRequest,
	).Scan(&winnerEntries); err != nil {
		t.Fatalf("count winner journal entries: %v", err)
	}
	if winnerEntries != 1 {
		t.Errorf("winner journal entry count = %d, want 1", winnerEntries)
	}

	if err := testDB.QueryRowContext(
		ctx,
		`SELECT count(*) FROM journal_entries WHERE ledger_id = $1 AND request_id = $2`,
		fixture.ledgerID, loserRequest,
	).Scan(&loserEntries); err != nil {
		t.Fatalf("count loser journal entries: %v", err)
	}
	if loserEntries != 0 {
		t.Errorf("loser journal entry count = %d, want 0", loserEntries)
	}

	var lineCount int
	if err := testDB.QueryRowContext(
		ctx,
		`SELECT count(*) FROM journal_lines WHERE ledger_id = $1`,
		fixture.ledgerID,
	).Scan(&lineCount); err != nil {
		t.Fatalf("count journal lines: %v", err)
	}
	if lineCount != 2 {
		t.Errorf("journal line count = %d, want 2 (funding + winner)", lineCount)
	}

	// Only the winner spent: the payable's debit counter moved once, the fee
	// account was credited once, and the funding cash account is untouched.
	deltas := map[int64]accountBalances{
		fixture.platform.Cash.ID:       {},
		fixture.platform.FeeRevenue.ID: {CreditsPosted: spend},
		fixture.payable.ID:             {DebitsPosted: spend},
	}
	for id, delta := range deltas {
		want := accountBalances{
			DebitsPending:  before[id].DebitsPending,
			CreditsPending: before[id].CreditsPending,
			DebitsPosted:   before[id].DebitsPosted + delta.DebitsPosted,
			CreditsPosted:  before[id].CreditsPosted + delta.CreditsPosted,
		}
		if got := readAccountBalances(t, testDB, id); got != want {
			t.Errorf("account %d balances = %+v, want %+v", id, got, want)
		}
	}
}

// committedPostEntryFixture seeds committed prerequisite rows for tests that
// need real independent transactions: concurrency tests cannot share a single
// *sql.Tx. The fixture is committed, so the test owns the data; a unique slug
// and holder external ID keep the rows isolated from other tests, and a
// registered cleanup deletes every committed row.
type committedPostEntryFixture struct {
	ledgerID int
	slug     string
	payable  seededAccount
	platform platformAccounts
}

func newCommittedPostEntryFixture(t *testing.T) committedPostEntryFixture {
	t.Helper()

	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()

	slug := "ngn_ng_" + ulid.Make().String()
	externalID := "merchant_" + ulid.Make().String()

	setupTx, err := testDB.BeginTx(ctx, nil)
	if err != nil {
		t.Fatalf("begin setup transaction: %v", err)
	}
	defer func() { _ = setupTx.Rollback() }()

	ledgerID := seedLedger(t, setupTx, slug, "NGN")
	platform := seedPlatformAccounts(t, setupTx, ledgerID)

	setupStore := postgres.New(setupTx)
	payable, err := setupStore.CreatePayableAccount(t.Context(), account.CreatePayableInput{
		LedgerSlug: slug,
		ExternalID: externalID,
		Name:       "Concurrent Merchant Ltd",
	})
	if err != nil {
		t.Fatalf("create payable account: %v", err)
	}
	payableAccount := lookupSeededAccount(t, setupTx, payable.Account.Reference)
	if err := setupTx.Commit(); err != nil {
		t.Fatalf("commit setup transaction: %v", err)
	}

	t.Cleanup(func() {
		// Cleanup runs after t.Context() is canceled, so use a fresh context.
		cleanupCtx, cancelCleanup := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancelCleanup()

		stmts := []struct {
			query string
			arg   any
		}{
			{`DELETE FROM journal_lines WHERE ledger_id = $1`, ledgerID},
			{`DELETE FROM journal_entries WHERE ledger_id = $1`, ledgerID},
			{`DELETE FROM accounts WHERE ledger_id = $1`, ledgerID},
			{`DELETE FROM holders WHERE external_id = $1`, externalID},
			{`DELETE FROM ledgers WHERE id = $1`, ledgerID},
		}
		for _, stmt := range stmts {
			if _, err := testDB.ExecContext(cleanupCtx, stmt.query, stmt.arg); err != nil {
				t.Errorf("clean up committed fixture (%s): %v", stmt.query, err)
			}
		}
	})

	return committedPostEntryFixture{
		ledgerID: ledgerID,
		slug:     slug,
		payable:  payableAccount,
		platform: platform,
	}
}

// mustPostCommitted posts an entry through its own committed transaction.
func (f committedPostEntryFixture) mustPostCommitted(
	t *testing.T,
	ctx context.Context,
	input journal.PostInput,
) journal.PostResult {
	t.Helper()

	tx, err := testDB.BeginTx(ctx, nil)
	if err != nil {
		t.Fatalf("begin post transaction: %v", err)
	}
	defer func() { _ = tx.Rollback() }()

	result, err := postgres.New(tx).PostEntry(ctx, input)
	if err != nil {
		t.Fatalf("PostEntry() error = %v", err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatalf("commit post transaction: %v", err)
	}

	return result
}

type postOutcome struct {
	result journal.PostResult
	err    error
}

// postOverlapping proves two posts genuinely overlap at a database lock rather
// than trusting goroutine scheduling. It leaves tx1 uncommitted, waits until
// PostgreSQL reports tx2 blocked on a lock, and only then commits tx1.
func postOverlapping(
	t *testing.T,
	ctx context.Context,
	tx1 *sql.Tx,
	firstInput journal.PostInput,
	tx2 *sql.Tx,
	secondInput journal.PostInput,
) (journal.PostResult, postOutcome) {
	t.Helper()

	var secondPID int
	if err := tx2.QueryRowContext(ctx, `SELECT pg_backend_pid()`).Scan(&secondPID); err != nil {
		t.Fatalf("read second transaction backend PID: %v", err)
	}

	first, err := postgres.New(tx1).PostEntry(ctx, firstInput)
	if err != nil {
		t.Fatalf("first PostEntry() error = %v", err)
	}

	secondDone := make(chan postOutcome, 1)
	go func() {
		result, err := postgres.New(tx2).PostEntry(ctx, secondInput)
		secondDone <- postOutcome{result: result, err: err}
	}()

	waitForDatabaseLock(t, ctx, secondPID, secondDone)

	if err := tx1.Commit(); err != nil {
		t.Fatalf("commit first transaction: %v", err)
	}

	second := <-secondDone
	if second.err == nil {
		if err := tx2.Commit(); err != nil {
			t.Fatalf("commit second transaction: %v", err)
		}
	} else {
		_ = tx2.Rollback()
	}

	return first, second
}

// waitForDatabaseLock waits for positive evidence from PostgreSQL that the
// second posting reached and is waiting at a lock held by the first posting.
func waitForDatabaseLock(
	t *testing.T,
	ctx context.Context,
	backendPID int,
	done <-chan postOutcome,
) {
	t.Helper()

	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case outcome := <-done:
			t.Fatalf(
				"second PostEntry() completed before waiting on a database lock: (Created %t, err %v)",
				outcome.result.Created, outcome.err,
			)
		case <-ctx.Done():
			t.Fatalf("wait for second PostEntry() to block: %v", context.Cause(ctx))
		case <-ticker.C:
			var waitEventType sql.NullString
			err := testDB.QueryRowContext(
				ctx,
				`SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1`,
				backendPID,
			).Scan(&waitEventType)
			if err != nil {
				t.Fatalf("inspect second PostEntry() lock state: %v", err)
			}
			if waitEventType.Valid && waitEventType.String == "Lock" {
				return
			}
		}
	}
}
