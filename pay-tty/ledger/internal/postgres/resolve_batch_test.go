//go:build integration

package postgres_test

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"paytty.akeju.me/ledger/internal/journal"
	"paytty.akeju.me/ledger/internal/postgres"
)

func captureItems(keyPrefix string, refs []string) []journal.ResolveBatchItemInput {
	items := make([]journal.ResolveBatchItemInput, len(refs))
	for i, ref := range refs {
		items[i] = journal.ResolveBatchItemInput{
			RequestID:        fmt.Sprintf("%s_%d", keyPrefix, i),
			PendingReference: ref,
			Action:           journal.ActionCapture,
		}
	}
	return items
}

func (f postEntryFixture) holds(t *testing.T, n int, amount int64) []string {
	t.Helper()
	refs := make([]string, n)
	for i := range refs {
		refs[i] = f.hold(t, fmt.Sprintf("hold_%d", i), amount).Entry.Reference
	}
	return refs
}

func TestStore_ResolveEntries_CapturesForOneAccount(t *testing.T) {
	f := newPostEntryFixture(t)
	f.fund(t, 10_000)
	refs := f.holds(t, 10, 100)

	result, err := f.store.ResolveEntries(t.Context(), journal.ResolveBatchInput{
		LedgerSlug: f.slug,
		Items:      captureItems("cap", refs),
	})
	if err != nil {
		t.Fatalf("ResolveEntries() error = %v", err)
	}
	for i, r := range result.Results {
		if r.Status != journal.BatchItemCreated || r.JournalRef == nil || r.PendingState == nil || *r.PendingState != journal.StateCaptured || r.PendingReference != refs[i] {
			t.Errorf("result %d = %+v", i, r)
		}
	}

	if got := readAccountBalances(t, f.tx, f.payable.ID); got != (accountBalances{DebitsPosted: 1_000, CreditsPosted: 10_000}) {
		t.Errorf("payable = %+v", got)
	}

	want := []accountMovementRow{{Sequence: 1, LineNumber: 1, Direction: "credit", Amount: 10_000, Purpose: "Card payment", BalanceAfter: 10_000}}
	for i := range refs {
		want = append(want, accountMovementRow{
			Sequence: int64(i + 2), LineNumber: 1, Direction: "debit", Amount: 100, Purpose: "payout",
			BalanceAfter: 10_000 - int64(i+1)*100,
		})
	}
	assertAccountMovements(t, f.tx, f.payable.ID, want)

	// The batch's movements share one recorded_at, in item order.
	var stamps int
	if err := f.tx.QueryRowContext(t.Context(), `
		SELECT count(DISTINCT recorded_at) FROM account_movements
		WHERE account_id = $1 AND sequence > 1`, f.payable.ID).Scan(&stamps); err != nil {
		t.Fatal(err)
	}
	if stamps != 1 {
		t.Errorf("distinct recorded_at = %d, want 1", stamps)
	}
	for i, ref := range refs {
		auth, _ := readAuthorization(t, f.tx, ref)
		if auth.State != "captured" || auth.Resolution.String != *result.Results[i].JournalRef {
			t.Errorf("authorization %d = %+v", i, auth)
		}
	}
}

func TestStore_ResolveEntries_MixedOutcomes(t *testing.T) {
	f := newPostEntryFixture(t)
	f.fund(t, 10_000)
	refs := f.holds(t, 7, 100)
	won := f.mustResolve(t, "earlier_void", refs[0], journal.ActionVoid)
	immediate := f.mustPost(t, journal.PostInput{
		LedgerSlug: f.slug, RequestID: "imm", Kind: "payment", Description: "Payment received",
		Lines: []journal.LineInput{{
			DebitAccountReference: f.platform.Cash.Reference, CreditAccountReference: f.payable.Reference,
			Amount: 1, Purpose: "Card payment",
		}},
	}).Entry.Reference

	items := []journal.ResolveBatchItemInput{
		{RequestID: "b_resolved", PendingReference: refs[0], Action: journal.ActionCapture},
		{RequestID: "b_ok_0", PendingReference: refs[6], Action: journal.ActionVoid},
		{RequestID: "b_immediate", PendingReference: immediate, Action: journal.ActionVoid},
		{RequestID: "b_unknown", PendingReference: "jrn_01K33YW0MDHJ9E4N7Z2QPV6R8K", Action: journal.ActionVoid},
		{RequestID: "imm", PendingReference: refs[1], Action: journal.ActionCapture},
		{RequestID: "b_ok_1", PendingReference: refs[2], Action: journal.ActionCapture},
		{RequestID: "b_ok_2", PendingReference: refs[3], Action: journal.ActionVoid},
		{RequestID: "b_ok_3", PendingReference: refs[4], Action: journal.ActionCapture},
		{RequestID: "b_ok_4", PendingReference: refs[5], Action: journal.ActionVoid},
		{RequestID: "b_ok_5", PendingReference: "jrn_01K33YW0MDHJ9E4N7Z2QPV6R8M", Action: journal.ActionVoid},
	}
	result, err := f.store.ResolveEntries(t.Context(), journal.ResolveBatchInput{LedgerSlug: f.slug, Items: items})
	if err != nil {
		t.Fatalf("ResolveEntries() error = %v", err)
	}

	wantCodes := []string{"entry_resolved", "", "entry_not_pending", "entry_not_found", "idempotency_conflict", "", "", "", "", "entry_not_found"}
	for i, r := range result.Results {
		code := ""
		if r.Error != nil {
			code = r.Error.Code
		}
		if code != wantCodes[i] {
			t.Errorf("item %d (%s) code = %q, want %q", i, r.RequestID, code, wantCodes[i])
		}
		if code != "" {
			if r.Status != journal.BatchItemRejected || r.JournalRef != nil {
				t.Errorf("item %d = %+v, want rejected without a ref", i, r)
			}
			if code != "idempotency_conflict" {
				assertNoJournalEntry(t, f.tx, f.ledgerID, r.RequestID)
			}
		}
	}
	first := result.Results[0]
	if first.PendingState == nil || *first.PendingState != journal.StateVoided || first.ResolvedBy == nil || *first.ResolvedBy != won.Resolution.Reference {
		t.Errorf("entry_resolved item = %+v, want voided by %s", first, won.Resolution.Reference)
	}

	// Two captures of 100; refs[1] stays held under its conflicting key.
	if got := readAccountBalances(t, f.tx, f.payable.ID); got != (accountBalances{DebitsPending: 100, DebitsPosted: 200, CreditsPosted: 10_001}) {
		t.Errorf("payable = %+v", got)
	}
}

func TestStore_ResolveEntries_ReplaysAcrossEndpoints(t *testing.T) {
	f := newPostEntryFixture(t)
	f.fund(t, 10_000)
	refs := f.holds(t, 10, 100)
	single := f.mustResolve(t, "cap_0", refs[0], journal.ActionCapture)

	input := journal.ResolveBatchInput{LedgerSlug: f.slug, Items: captureItems("cap", refs)}
	first, err := f.store.ResolveEntries(t.Context(), input)
	if err != nil {
		t.Fatalf("ResolveEntries() error = %v", err)
	}
	if first.Results[0].Status != journal.BatchItemExisting || *first.Results[0].JournalRef != single.Resolution.Reference {
		t.Errorf("item resolved through the single endpoint = %+v, want existing", first.Results[0])
	}
	for _, r := range first.Results[1:] {
		if r.Status != journal.BatchItemCreated {
			t.Errorf("first send %s = %s, want created", r.RequestID, r.Status)
		}
	}

	again, err := f.store.ResolveEntries(t.Context(), input)
	if err != nil {
		t.Fatalf("replayed ResolveEntries() error = %v", err)
	}
	for i, r := range again.Results {
		if r.Status != journal.BatchItemExisting || *r.JournalRef != *first.Results[i].JournalRef || *r.PendingState != journal.StateCaptured {
			t.Errorf("replay %d = %+v", i, r)
		}
	}

	viaSingle := f.mustResolve(t, "cap_5", refs[5], journal.ActionCapture)
	if viaSingle.Created || viaSingle.Resolution.Reference != *first.Results[5].JournalRef {
		t.Errorf("single replay of a batch item = %+v (created %t)", viaSingle.Resolution, viaSingle.Created)
	}
	if got := readAccountBalances(t, f.tx, f.payable.ID); got != (accountBalances{DebitsPosted: 1_000, CreditsPosted: 10_000}) {
		t.Errorf("payable = %+v", got)
	}
}

func TestStore_ResolveEntries_WholeBatchFailures(t *testing.T) {
	f := newPostEntryFixture(t)
	f.fund(t, 1_000_000)
	refs := f.holds(t, 11, 1)

	tooMany := make([]string, journal.MaxBatchEntries+1)
	for i := range tooMany {
		tooMany[i] = fmt.Sprintf("jrn_%026d", i)
	}
	dupKey := captureItems("k", refs[:10])
	dupKey[9].RequestID = dupKey[0].RequestID
	dupRef := captureItems("k", refs[:10])
	dupRef[9].PendingReference = refs[0]

	for name, tc := range map[string]struct {
		slug  string
		items []journal.ResolveBatchItemInput
		want  error
	}{
		"too small":         {f.slug, captureItems("k", refs[:9]), journal.ErrBatchTooSmall},
		"too large":         {f.slug, captureItems("k", tooMany), journal.ErrBatchSizeExceeded},
		"duplicate key":     {f.slug, dupKey, journal.ErrIdempotencyConflict},
		"duplicate pending": {f.slug, dupRef, journal.ErrDuplicatePendingReference},
		"unknown ledger":    {"usd_us", captureItems("k", refs[:10]), journal.ErrLedgerNotFound},
	} {
		err := runWithRollbackSavepoint(t, f.tx, func() error {
			_, err := f.store.ResolveEntries(t.Context(), journal.ResolveBatchInput{LedgerSlug: tc.slug, Items: tc.items})
			return err
		})
		if !errors.Is(err, tc.want) {
			t.Errorf("%s: error = %v, want %v", name, err, tc.want)
		}
	}
}

// TestStore_ResolveEntries_ClosedLedger resolves holds after their ledger
// closes, so closing never strands an amount in the pending counters.
func TestStore_ResolveEntries_ClosedLedger(t *testing.T) {
	f := newPostEntryFixture(t)
	f.fund(t, 10_000)
	refs := f.holds(t, 10, 100)
	if _, err := f.tx.ExecContext(t.Context(), `UPDATE ledgers SET is_closed = true WHERE id = $1`, f.ledgerID); err != nil {
		t.Fatal(err)
	}

	result, err := f.store.ResolveEntries(t.Context(), journal.ResolveBatchInput{LedgerSlug: f.slug, Items: captureItems("k", refs)})
	if err != nil {
		t.Fatalf("ResolveEntries() error = %v", err)
	}
	for i, r := range result.Results {
		if r.Status != journal.BatchItemCreated {
			t.Errorf("item %d = %+v, want created", i, r)
		}
	}
	if got := readAccountBalances(t, f.tx, f.payable.ID); got != (accountBalances{DebitsPosted: 1_000, CreditsPosted: 10_000}) {
		t.Errorf("payable = %+v", got)
	}
}

// TestStore_ResolveEntries_ConcurrentWithSingles runs a batch and single
// resolutions of the same entries at once. Each entry must be resolved once,
// and the lock order must leave no deadlock.
func TestStore_ResolveEntries_ConcurrentWithSingles(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()

	for attempt := range 3 {
		f := newCommittedPostEntryFixture(t)
		f.mustPostCommitted(t, ctx, journal.PostInput{
			LedgerSlug: f.slug, RequestID: "fund", Kind: "payment", Description: "Payment received",
			Lines: []journal.LineInput{{
				DebitAccountReference: f.platform.Cash.Reference, CreditAccountReference: f.payable.Reference,
				Amount: 1_000_000, Purpose: "Card payment",
			}},
		})
		refs := make([]string, 200)
		for i := range refs {
			refs[i] = f.holdCommitted(t, ctx, fmt.Sprintf("hold_%d", i), 10).Entry.Reference
		}

		var (
			wg       sync.WaitGroup
			mu       sync.Mutex
			failures []error
		)
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := postgres.New(testDB).ResolveEntries(ctx, journal.ResolveBatchInput{
				LedgerSlug: f.slug, Items: captureItems("batch", refs),
			})
			if err != nil {
				mu.Lock()
				failures = append(failures, fmt.Errorf("batch: %w", err))
				mu.Unlock()
			}
		}()
		for i := len(refs) - 1; i >= len(refs)-20; i-- {
			wg.Add(1)
			go func() {
				defer wg.Done()
				_, err := postgres.New(testDB).ResolveEntry(ctx, journal.ResolveInput{
					LedgerSlug: f.slug, RequestID: fmt.Sprintf("single_%d", i), PendingReference: refs[i], Action: journal.ActionVoid,
				})
				if err != nil && !errors.Is(err, journal.ErrEntryResolved) {
					mu.Lock()
					failures = append(failures, fmt.Errorf("single %d: %w", i, err))
					mu.Unlock()
				}
			}()
		}
		wg.Wait()

		for _, err := range failures {
			if strings.Contains(err.Error(), "40P01") {
				t.Fatalf("attempt %d: deadlock: %v", attempt, err)
			}
			t.Errorf("attempt %d: %v", attempt, err)
		}

		var resolved, pending int
		if err := testDB.QueryRowContext(ctx, `
			SELECT count(*) FILTER (WHERE state <> 'pending'), count(*) FILTER (WHERE state = 'pending')
			FROM authorizations WHERE ledger_id = $1`, f.ledgerID).Scan(&resolved, &pending); err != nil {
			t.Fatal(err)
		}
		var resolutions int
		if err := testDB.QueryRowContext(ctx, `
			SELECT count(*) FROM journal_entries
			WHERE ledger_id = $1 AND (request_id LIKE 'batch_%' OR request_id LIKE 'single_%')`, f.ledgerID).Scan(&resolutions); err != nil {
			t.Fatal(err)
		}
		if resolved != len(refs) || pending != 0 || resolutions != len(refs) {
			t.Errorf("attempt %d: resolved %d, pending %d, resolution entries %d; want %d, 0, %d",
				attempt, resolved, pending, resolutions, len(refs), len(refs))
		}
		if got := readAccountBalances(t, testDB, f.payable.ID); got.DebitsPending != 0 || got.DebitsPosted > int64(len(refs))*10 {
			t.Errorf("attempt %d: payable = %+v", attempt, got)
		}
	}
}

func TestStore_PostEntries_PendingHoldsInBatchOrder(t *testing.T) {
	f := newPostEntryFixture(t)
	f.fund(t, 1_000)

	entries := []journal.BatchItemInput{}
	for i, amount := range []int64{600, 500, 400} {
		in := payoutHold(f.slug, fmt.Sprintf("bh_%d", i), f.payable.Reference, f.platform.Cash.Reference, amount)
		entries = append(entries, journal.BatchItemInput{
			RequestID: in.RequestID, Kind: in.Kind, Description: in.Description,
			Lines: in.Lines, Pending: true,
		})
	}
	entries = padBatch(f.platform, "pending", entries)

	result, err := f.store.PostEntries(t.Context(), journal.BatchInput{LedgerSlug: f.slug, Entries: entries})
	if err != nil {
		t.Fatalf("PostEntries() error = %v", err)
	}
	if r := result.Results[0]; r.Status != journal.BatchItemCreated || r.State != journal.StatePending {
		t.Errorf("first hold = %+v", r)
	}
	if r := result.Results[1]; r.Status != journal.BatchItemRejected || r.Error == nil || r.Error.Code != "insufficient_funds" {
		t.Errorf("second hold = %+v, want insufficient_funds", r)
	}
	if r := result.Results[2]; r.Status != journal.BatchItemCreated || r.State != journal.StatePending {
		t.Errorf("third hold = %+v", r)
	}
	if r := result.Results[3]; r.State != journal.StatePosted {
		t.Errorf("filler state = %q, want posted", r.State)
	}
	if got := readAccountBalances(t, f.tx, f.payable.ID); got != (accountBalances{DebitsPending: 1_000, CreditsPosted: 1_000}) {
		t.Errorf("payable = %+v", got)
	}
	// No movements for holds.
	assertAccountMovements(t, f.tx, f.payable.ID, []accountMovementRow{
		{Sequence: 1, LineNumber: 1, Direction: "credit", Amount: 1_000, Purpose: "Card payment", BalanceAfter: 1_000},
	})
	for _, i := range []int{0, 2} {
		if auth, ok := readAuthorization(t, f.tx, *result.Results[i].JournalRef); !ok || auth.State != "pending" {
			t.Errorf("hold %d authorization = %+v (found %t)", i, auth, ok)
		}
	}

	// Replays report the stored state, through either endpoint.
	again, err := f.store.PostEntries(t.Context(), journal.BatchInput{LedgerSlug: f.slug, Entries: entries})
	if err != nil {
		t.Fatalf("replayed PostEntries() error = %v", err)
	}
	if r := again.Results[0]; r.Status != journal.BatchItemExisting || r.State != journal.StatePending {
		t.Errorf("replayed hold = %+v", r)
	}
	single := f.mustPost(t, payoutHold(f.slug, "bh_0", f.payable.Reference, f.platform.Cash.Reference, 600))
	if single.Created || single.Entry.Reference != *result.Results[0].JournalRef {
		t.Errorf("single replay of a batch hold = %+v", single)
	}
}
