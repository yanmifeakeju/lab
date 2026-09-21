//go:build integration

package postgres_test

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"yanmifeakeju.com/ledger/internal/account"
	"yanmifeakeju.com/ledger/internal/journal"
	"yanmifeakeju.com/ledger/internal/postgres"
)

// TestStore_PostEntries_MixedOutcomes verifies that a batch containing created,
// existing, and rejected entries returns each outcome in request order, and only
// the created entries leave journal rows.
func TestStore_PostEntries_MixedOutcomes(t *testing.T) {
	fixture := newPostEntryFixture(t)

	// Pre-create an existing entry
	effectiveAt := time.Date(2026, time.September, 18, 10, 0, 0, 0, time.UTC)
	existingPost := fixture.mustPost(t, journal.PostInput{
		LedgerSlug:  fixture.slug,
		RequestID:   "pre_existing_1",
		Kind:        "payment",
		Description: "Pre-existing payment",
		EffectiveAt: &effectiveAt,
		Lines: []journal.LineInput{
			{
				DebitAccountReference:  fixture.platform.Cash.Reference,
				CreditAccountReference: fixture.payable.Reference,
				Amount:                 5000,
				Purpose:                "Pre-existing",
			},
		},
	})

	batchResult, err := fixture.store.PostEntries(t.Context(), journal.BatchInput{
		LedgerSlug: fixture.slug,
		Entries: padBatch(fixture.platform, "b1", []journal.BatchItemInput{
			{
				RequestID:   "batch_entry_1",
				Kind:        "payment",
				Description: "First new payment",
				Lines: []journal.LineInput{
					{
						DebitAccountReference:  fixture.platform.Cash.Reference,
						CreditAccountReference: fixture.payable.Reference,
						Amount:                 10000,
						Purpose:                "Card payment",
					},
				},
			},
			{
				RequestID:   "pre_existing_1",
				Kind:        "payment",
				Description: "Pre-existing payment",
				EffectiveAt: &effectiveAt,
				Lines: []journal.LineInput{
					{
						DebitAccountReference:  fixture.platform.Cash.Reference,
						CreditAccountReference: fixture.payable.Reference,
						Amount:                 5000,
						Purpose:                "Pre-existing",
					},
				},
			},
			{
				RequestID:   "batch_entry_bad_account",
				Kind:        "payment",
				Description: "Payment to missing account",
				Lines: []journal.LineInput{
					{
						DebitAccountReference:  fixture.platform.Cash.Reference,
						CreditAccountReference: "acct_01K00000000000000000000000",
						Amount:                 2000,
						Purpose:                "Card payment",
					},
				},
			},
			{
				RequestID:   "batch_entry_2",
				Kind:        "payment",
				Description: "Second new payment",
				Lines: []journal.LineInput{
					{
						DebitAccountReference:  fixture.platform.Cash.Reference,
						CreditAccountReference: fixture.payable.Reference,
						Amount:                 3000,
						Purpose:                "Card payment",
					},
				},
			},
		}),
	})
	if err != nil {
		t.Fatalf("PostEntries() error = %v", err)
	}

	if len(batchResult.Results) != journal.MinBatchEntries {
		t.Fatalf("results count = %d, want %d", len(batchResult.Results), journal.MinBatchEntries)
	}

	// 1. First entry: created
	r0 := batchResult.Results[0]
	if r0.RequestID != "batch_entry_1" || r0.Status != journal.BatchItemCreated {
		t.Errorf("r0: got %s %s, want batch_entry_1 created", r0.RequestID, r0.Status)
	}
	if r0.JournalRef == nil || *r0.JournalRef == "" {
		t.Errorf("r0: want non-nil JournalRef")
	}
	if r0.Error != nil {
		t.Errorf("r0: want nil Error, got %v", r0.Error)
	}

	// 2. Second entry: existing
	r1 := batchResult.Results[1]
	if r1.RequestID != "pre_existing_1" || r1.Status != journal.BatchItemExisting {
		t.Errorf("r1: got %s %s, want pre_existing_1 existing", r1.RequestID, r1.Status)
	}
	if r1.JournalRef == nil || *r1.JournalRef != existingPost.Entry.Reference {
		t.Errorf("r1: JournalRef = %v, want %s", r1.JournalRef, existingPost.Entry.Reference)
	}
	if r1.Error != nil {
		t.Errorf("r1: want nil Error, got %v", r1.Error)
	}

	// 3. Third entry: rejected (account_not_found)
	r2 := batchResult.Results[2]
	if r2.RequestID != "batch_entry_bad_account" || r2.Status != journal.BatchItemRejected {
		t.Errorf("r2: got %s %s, want batch_entry_bad_account rejected", r2.RequestID, r2.Status)
	}
	if r2.JournalRef != nil {
		t.Errorf("r2: want nil JournalRef, got %v", r2.JournalRef)
	}
	if r2.Error == nil || r2.Error.Code != "account_not_found" {
		t.Errorf("r2: want account_not_found error, got %v", r2.Error)
	}

	// 4. Fourth entry: created
	r3 := batchResult.Results[3]
	if r3.RequestID != "batch_entry_2" || r3.Status != journal.BatchItemCreated {
		t.Errorf("r3: got %s %s, want batch_entry_2 created", r3.RequestID, r3.Status)
	}
	if r3.JournalRef == nil || *r3.JournalRef == "" {
		t.Errorf("r3: want non-nil JournalRef")
	}
	if r3.Error != nil {
		t.Errorf("r3: want nil Error, got %v", r3.Error)
	}

	// Verify rejected entry left no rows in journal_entries
	var rejectedCount int
	err = fixture.tx.QueryRowContext(
		t.Context(),
		`SELECT count(*) FROM journal_entries WHERE ledger_id = $1 AND request_id = $2`,
		fixture.ledgerID,
		"batch_entry_bad_account",
	).Scan(&rejectedCount)
	if err != nil {
		t.Fatalf("query rejected entry count: %v", err)
	}
	if rejectedCount != 0 {
		t.Errorf("rejected entry left %d journal rows, want 0", rejectedCount)
	}
}

// TestStore_PostEntries_LimitEnforcementInMemory verifies that an entry that would
// exceed an account limit is rejected while subsequent entries in the batch that fit
// against the running balance are posted.
func TestStore_PostEntries_LimitEnforcementInMemory(t *testing.T) {
	fixture := newPostEntryFixture(t)

	// Fund payable account with 10,000
	fixture.mustPost(t, journal.PostInput{
		LedgerSlug:  fixture.slug,
		RequestID:   "initial_funding",
		Kind:        "payment",
		Description: "Initial funding",
		Lines: []journal.LineInput{
			{
				DebitAccountReference:  fixture.platform.Cash.Reference,
				CreditAccountReference: fixture.payable.Reference,
				Amount:                 10000,
				Purpose:                "Funding",
			},
		},
	})

	// Now send a batch with 3 payouts from payable back to cash:
	// Entry 1: 6,000 -> balance becomes 4,000 (succeeds)
	// Entry 2: 5,000 -> would need 5,000 but only 4,000 left -> rejected insufficient_funds
	// Entry 3: 3,000 -> fits within 4,000 -> balance becomes 1,000 (succeeds)
	batchResult, err := fixture.store.PostEntries(t.Context(), journal.BatchInput{
		LedgerSlug: fixture.slug,
		Entries: padBatch(fixture.platform, "b2", []journal.BatchItemInput{
			{
				RequestID:   "payout_1",
				Kind:        "payout",
				Description: "First payout of 6,000",
				Lines: []journal.LineInput{
					{
						DebitAccountReference:  fixture.payable.Reference,
						CreditAccountReference: fixture.platform.Cash.Reference,
						Amount:                 6000,
						Purpose:                "Payout 1",
					},
				},
			},
			{
				RequestID:   "payout_2_too_large",
				Kind:        "payout",
				Description: "Second payout of 5,000 (exceeds)",
				Lines: []journal.LineInput{
					{
						DebitAccountReference:  fixture.payable.Reference,
						CreditAccountReference: fixture.platform.Cash.Reference,
						Amount:                 5000,
						Purpose:                "Payout 2",
					},
				},
			},
			{
				RequestID:   "payout_3_fits",
				Kind:        "payout",
				Description: "Third payout of 3,000 (fits)",
				Lines: []journal.LineInput{
					{
						DebitAccountReference:  fixture.payable.Reference,
						CreditAccountReference: fixture.platform.Cash.Reference,
						Amount:                 3000,
						Purpose:                "Payout 3",
					},
				},
			},
		}),
	})
	if err != nil {
		t.Fatalf("PostEntries() error = %v", err)
	}

	if len(batchResult.Results) != journal.MinBatchEntries {
		t.Fatalf("got %d results, want %d", len(batchResult.Results), journal.MinBatchEntries)
	}

	if batchResult.Results[0].Status != journal.BatchItemCreated {
		t.Errorf("payout_1 status = %s, want created", batchResult.Results[0].Status)
	}
	if batchResult.Results[1].Status != journal.BatchItemRejected || batchResult.Results[1].Error.Code != "insufficient_funds" {
		t.Errorf("payout_2 status = %s error = %v, want rejected insufficient_funds",
			batchResult.Results[1].Status, batchResult.Results[1].Error)
	}
	if batchResult.Results[2].Status != journal.BatchItemCreated {
		t.Errorf("payout_3 status = %s, want created", batchResult.Results[2].Status)
	}

	// Verify payable account counters and movements
	payableBalances := readAccountBalances(t, fixture.tx, fixture.payable.ID)
	// Credits: 10,000. Debits: 6,000 + 3,000 = 9,000. Net balance = 1,000.
	if payableBalances.CreditsPosted != 10000 {
		t.Errorf("CreditsPosted = %d, want 10000", payableBalances.CreditsPosted)
	}
	if payableBalances.DebitsPosted != 9000 {
		t.Errorf("DebitsPosted = %d, want 9000", payableBalances.DebitsPosted)
	}
	var movementCount int64
	if err := fixture.tx.QueryRowContext(t.Context(), `SELECT movement_count FROM accounts WHERE id = $1`, fixture.payable.ID).Scan(&movementCount); err != nil {
		t.Fatalf("query movement_count: %v", err)
	}
	if movementCount != 3 {
		t.Errorf("MovementCount = %d, want 3", movementCount)
	}
}

// TestStore_PostEntries_MovementsSequentialAndConsecutive verifies that several entries
// for one payable account receive consecutive sequence numbers in batch order, share one
// recorded_at, and the latest balance_after equals credits_posted - debits_posted.
func TestStore_PostEntries_MovementsSequentialAndConsecutive(t *testing.T) {
	fixture := newPostEntryFixture(t)

	batchResult, err := fixture.store.PostEntries(t.Context(), journal.BatchInput{
		LedgerSlug: fixture.slug,
		Entries: padBatch(fixture.platform, "b3", []journal.BatchItemInput{
			{
				RequestID:   "seq_1",
				Kind:        "payment",
				Description: "Payment leg 1",
				Lines: []journal.LineInput{
					{
						DebitAccountReference:  fixture.platform.Cash.Reference,
						CreditAccountReference: fixture.payable.Reference,
						Amount:                 1000,
						Purpose:                "Leg 1",
					},
				},
			},
			{
				RequestID:   "seq_2",
				Kind:        "payment",
				Description: "Payment leg 2",
				Lines: []journal.LineInput{
					{
						DebitAccountReference:  fixture.platform.Cash.Reference,
						CreditAccountReference: fixture.payable.Reference,
						Amount:                 2000,
						Purpose:                "Leg 2",
					},
				},
			},
			{
				RequestID:   "seq_3",
				Kind:        "payment",
				Description: "Payment leg 3",
				Lines: []journal.LineInput{
					{
						DebitAccountReference:  fixture.platform.Cash.Reference,
						CreditAccountReference: fixture.payable.Reference,
						Amount:                 3000,
						Purpose:                "Leg 3",
					},
				},
			},
		}),
	})
	if err != nil {
		t.Fatalf("PostEntries() error = %v", err)
	}

	for i, r := range batchResult.Results {
		if r.Status != journal.BatchItemCreated {
			t.Fatalf("result[%d] status = %s, want created", i, r.Status)
		}
	}

	// Read account movements
	rows, err := fixture.tx.QueryContext(
		t.Context(),
		`SELECT sequence, line_number, direction, amount, balance_after, recorded_at
		 FROM account_movements
		 WHERE account_id = $1
		 ORDER BY sequence`,
		fixture.payable.ID,
	)
	if err != nil {
		t.Fatalf("query movements: %v", err)
	}
	defer rows.Close()

	type mov struct {
		sequence     int64
		lineNumber   int16
		direction    string
		amount       int64
		balanceAfter int64
		recordedAt   time.Time
	}
	var movements []mov
	for rows.Next() {
		var m mov
		if err := rows.Scan(&m.sequence, &m.lineNumber, &m.direction, &m.amount, &m.balanceAfter, &m.recordedAt); err != nil {
			t.Fatalf("scan movement: %v", err)
		}
		movements = append(movements, m)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate movements: %v", err)
	}

	if len(movements) != 3 {
		t.Fatalf("movements count = %d, want 3", len(movements))
	}

	// Check consecutive sequences
	for i, m := range movements {
		wantSeq := int64(i + 1)
		if m.sequence != wantSeq {
			t.Errorf("movements[%d].sequence = %d, want %d", i, m.sequence, wantSeq)
		}
	}

	// Check balance_after progression: 1000, 3000, 6000
	wantBalances := []int64{1000, 3000, 6000}
	for i, m := range movements {
		if m.balanceAfter != wantBalances[i] {
			t.Errorf("movements[%d].balanceAfter = %d, want %d", i, m.balanceAfter, wantBalances[i])
		}
	}

	// Check shared recorded_at across the batch
	batchRecordedAt := movements[0].recordedAt
	for i, m := range movements[1:] {
		if !m.recordedAt.Equal(batchRecordedAt) {
			t.Errorf("movements[%d].recordedAt = %v, want %v", i+1, m.recordedAt, batchRecordedAt)
		}
	}

	// Latest balance_after equals credits_posted - debits_posted
	acctBalances := readAccountBalances(t, fixture.tx, fixture.payable.ID)
	if movements[2].balanceAfter != acctBalances.CreditsPosted-acctBalances.DebitsPosted {
		t.Errorf("latest balance_after (%d) != credits - debits (%d)",
			movements[2].balanceAfter, acctBalances.CreditsPosted-acctBalances.DebitsPosted)
	}
}

// TestStore_PostEntries_IdempotentRetry verifies that resending an identical batch returns
// every entry as existing and posts no new journal rows.
func TestStore_PostEntries_IdempotentRetry(t *testing.T) {
	fixture := newPostEntryFixture(t)

	batch := journal.BatchInput{
		LedgerSlug: fixture.slug,
		Entries: padBatch(fixture.platform, "b4", []journal.BatchItemInput{
			{
				RequestID:   "retry_batch_1",
				Kind:        "payment",
				Description: "Payment 1",
				Lines: []journal.LineInput{
					{
						DebitAccountReference:  fixture.platform.Cash.Reference,
						CreditAccountReference: fixture.payable.Reference,
						Amount:                 1000,
						Purpose:                "Leg 1",
					},
				},
			},
			{
				RequestID:   "retry_batch_2",
				Kind:        "payment",
				Description: "Payment 2",
				Lines: []journal.LineInput{
					{
						DebitAccountReference:  fixture.platform.Cash.Reference,
						CreditAccountReference: fixture.payable.Reference,
						Amount:                 2000,
						Purpose:                "Leg 2",
					},
				},
			},
		}),
	}

	firstRun, err := fixture.store.PostEntries(t.Context(), batch)
	if err != nil {
		t.Fatalf("first PostEntries() error = %v", err)
	}

	secondRun, err := fixture.store.PostEntries(t.Context(), batch)
	if err != nil {
		t.Fatalf("second PostEntries() error = %v", err)
	}

	if len(secondRun.Results) != journal.MinBatchEntries {
		t.Fatalf("secondRun results count = %d, want %d", len(secondRun.Results), journal.MinBatchEntries)
	}

	for i, r := range secondRun.Results {
		if r.Status != journal.BatchItemExisting {
			t.Errorf("secondRun[%d].Status = %s, want existing", i, r.Status)
		}
		if r.JournalRef == nil || *r.JournalRef != *firstRun.Results[i].JournalRef {
			t.Errorf("secondRun[%d].JournalRef = %v, want %v", i, r.JournalRef, firstRun.Results[i].JournalRef)
		}
	}

	// The retry must not have inserted a second copy of anything.
	var totalEntries int
	err = fixture.tx.QueryRowContext(t.Context(), `SELECT count(*) FROM journal_entries WHERE ledger_id = $1`, fixture.ledgerID).Scan(&totalEntries)
	if err != nil {
		t.Fatalf("query total entries: %v", err)
	}
	if totalEntries != journal.MinBatchEntries {
		t.Errorf("totalEntries = %d, want %d", totalEntries, journal.MinBatchEntries)
	}
}

// TestStore_PostEntries_CrossEndpointIdempotency verifies that an entry posted via
// PostEntry and then sent in a batch (or vice versa) is recognized as existing,
// and conflicts with different content.
func TestStore_PostEntries_CrossEndpointIdempotency(t *testing.T) {
	fixture := newPostEntryFixture(t)

	// 1. Post via single PostEntry
	singlePost, err := fixture.store.PostEntry(t.Context(), journal.PostInput{
		LedgerSlug:  fixture.slug,
		RequestID:   "cross_req_1",
		Kind:        "payment",
		Description: "Cross payment",
		Lines: []journal.LineInput{
			{
				DebitAccountReference:  fixture.platform.Cash.Reference,
				CreditAccountReference: fixture.payable.Reference,
				Amount:                 4000,
				Purpose:                "Cross test",
			},
		},
	})
	if err != nil {
		t.Fatalf("PostEntry() error = %v", err)
	}

	// 2. Retry identical content via batch PostEntries
	batchResult, err := fixture.store.PostEntries(t.Context(), journal.BatchInput{
		LedgerSlug: fixture.slug,
		Entries: padBatch(fixture.platform, "b5", []journal.BatchItemInput{
			{
				RequestID:   "cross_req_1",
				Kind:        "payment",
				Description: "Cross payment",
				Lines: []journal.LineInput{
					{
						DebitAccountReference:  fixture.platform.Cash.Reference,
						CreditAccountReference: fixture.payable.Reference,
						Amount:                 4000,
						Purpose:                "Cross test",
					},
				},
			},
		}),
	})
	if err != nil {
		t.Fatalf("batch PostEntries() retry error = %v", err)
	}
	if len(batchResult.Results) != journal.MinBatchEntries {
		t.Fatalf("batchResult length = %d, want %d", len(batchResult.Results), journal.MinBatchEntries)
	}
	if batchResult.Results[0].Status != journal.BatchItemExisting {
		t.Errorf("status = %s, want existing", batchResult.Results[0].Status)
	}
	if *batchResult.Results[0].JournalRef != singlePost.Entry.Reference {
		t.Errorf("batch JournalRef = %s, want %s", *batchResult.Results[0].JournalRef, singlePost.Entry.Reference)
	}

	// 3. Retry same key with DIFFERENT description in batch -> idempotency_conflict
	conflictBatch, err := fixture.store.PostEntries(t.Context(), journal.BatchInput{
		LedgerSlug: fixture.slug,
		Entries: padBatch(fixture.platform, "b6", []journal.BatchItemInput{
			{
				RequestID:   "cross_req_1",
				Kind:        "payment",
				Description: "DIFFERENT description",
				Lines: []journal.LineInput{
					{
						DebitAccountReference:  fixture.platform.Cash.Reference,
						CreditAccountReference: fixture.payable.Reference,
						Amount:                 4000,
						Purpose:                "Cross test",
					},
				},
			},
		}),
	})
	if err != nil {
		t.Fatalf("conflictBatch error = %v", err)
	}
	if conflictBatch.Results[0].Status != journal.BatchItemRejected || conflictBatch.Results[0].Error.Code != "idempotency_conflict" {
		t.Errorf("conflictBatch result = %v, want rejected idempotency_conflict", conflictBatch.Results[0])
	}
}

// TestStore_PostEntries_WholeBatchFailures verifies that requests that are invalid
// as a whole (duplicate key in batch, unknown ledger, closed ledger, empty batch) fail
// the entire transaction.
func TestStore_PostEntries_WholeBatchFailures(t *testing.T) {
	t.Run("duplicate key in batch fails whole batch", func(t *testing.T) {
		fixture := newPostEntryFixture(t)
		_, err := fixture.store.PostEntries(t.Context(), journal.BatchInput{
			LedgerSlug: fixture.slug,
			Entries: padBatch(fixture.platform, "b7", []journal.BatchItemInput{
				{
					RequestID:   "dup_key_1",
					Kind:        "payment",
					Description: "Entry 1",
					Lines: []journal.LineInput{
						{
							DebitAccountReference:  fixture.platform.Cash.Reference,
							CreditAccountReference: fixture.payable.Reference,
							Amount:                 100,
							Purpose:                "P",
						},
					},
				},
				{
					RequestID:   "dup_key_1", // duplicate!
					Kind:        "payment",
					Description: "Entry 2",
					Lines: []journal.LineInput{
						{
							DebitAccountReference:  fixture.platform.Cash.Reference,
							CreditAccountReference: fixture.payable.Reference,
							Amount:                 200,
							Purpose:                "P",
						},
					},
				},
			}),
		})
		if !errors.Is(err, journal.ErrIdempotencyConflict) {
			t.Errorf("err = %v, want ErrIdempotencyConflict", err)
		}
	})

	t.Run("ledger not found fails whole batch", func(t *testing.T) {
		fixture := newPostEntryFixture(t)
		_, err := fixture.store.PostEntries(t.Context(), journal.BatchInput{
			LedgerSlug: "unknown_ledger_slug",
			Entries: padBatch(fixture.platform, "b8", []journal.BatchItemInput{
				{
					RequestID:   "k1",
					Kind:        "payment",
					Description: "P",
					Lines: []journal.LineInput{
						{
							DebitAccountReference:  fixture.platform.Cash.Reference,
							CreditAccountReference: fixture.payable.Reference,
							Amount:                 100,
							Purpose:                "P",
						},
					},
				},
			}),
		})
		if !errors.Is(err, journal.ErrLedgerNotFound) {
			t.Errorf("err = %v, want ErrLedgerNotFound", err)
		}
	})

	t.Run("closed ledger fails whole batch for new entries", func(t *testing.T) {
		closeFixture := newPostEntryFixture(t)
		_, err := closeFixture.tx.ExecContext(t.Context(), `UPDATE ledgers SET is_closed = true WHERE id = $1`, closeFixture.ledgerID)
		if err != nil {
			t.Fatalf("close ledger: %v", err)
		}

		_, err = closeFixture.store.PostEntries(t.Context(), journal.BatchInput{
			LedgerSlug: closeFixture.slug,
			Entries: padBatch(closeFixture.platform, "b9", []journal.BatchItemInput{
				{
					RequestID:   "closed_post_1",
					Kind:        "payment",
					Description: "P",
					Lines: []journal.LineInput{
						{
							DebitAccountReference:  closeFixture.platform.Cash.Reference,
							CreditAccountReference: closeFixture.payable.Reference,
							Amount:                 100,
							Purpose:                "P",
						},
					},
				},
			}),
		})
		if !errors.Is(err, journal.ErrLedgerClosed) {
			t.Errorf("err = %v, want ErrLedgerClosed", err)
		}
	})

	t.Run("closed ledger fails whole batch for conflicting existing keys", func(t *testing.T) {
		fixture := newPostEntryFixture(t)
		entries := padBatch(fixture.platform, "closed_conflicts", []journal.BatchItemInput{
			{
				RequestID:   "closed_conflict_1",
				Kind:        "payment",
				Description: "Original content",
				Lines: []journal.LineInput{
					{
						DebitAccountReference:  fixture.platform.Cash.Reference,
						CreditAccountReference: fixture.payable.Reference,
						Amount:                 100,
						Purpose:                "P",
					},
				},
			},
		})

		if _, err := fixture.store.PostEntries(t.Context(), journal.BatchInput{
			LedgerSlug: fixture.slug,
			Entries:    entries,
		}); err != nil {
			t.Fatalf("post original batch: %v", err)
		}
		if _, err := fixture.tx.ExecContext(
			t.Context(),
			`UPDATE ledgers SET is_closed = true WHERE id = $1`,
			fixture.ledgerID,
		); err != nil {
			t.Fatalf("close ledger: %v", err)
		}

		for i := range entries {
			entries[i].Description += " conflicting"
		}
		_, err := fixture.store.PostEntries(t.Context(), journal.BatchInput{
			LedgerSlug: fixture.slug,
			Entries:    entries,
		})
		if !errors.Is(err, journal.ErrLedgerClosed) {
			t.Errorf("err = %v, want ErrLedgerClosed", err)
		}
	})

	t.Run("entry with no lines fails whole batch with ErrNoLines", func(t *testing.T) {
		fixture := newPostEntryFixture(t)
		_, err := fixture.store.PostEntries(t.Context(), journal.BatchInput{
			LedgerSlug: fixture.slug,
			Entries: padBatch(fixture.platform, "b10", []journal.BatchItemInput{
				{
					RequestID:   "no_lines_entry",
					Kind:        "payment",
					Description: "Entry with no lines",
					Lines:       []journal.LineInput{},
				},
			}),
		})
		if !errors.Is(err, journal.ErrNoLines) {
			t.Errorf("err = %v, want ErrNoLines", err)
		}
	})

	t.Run("batch size exceeded fails whole batch with ErrBatchSizeExceeded", func(t *testing.T) {
		fixture := newPostEntryFixture(t)
		entries := make([]journal.BatchItemInput, journal.MaxBatchEntries+1)
		for i := range entries {
			entries[i] = journal.BatchItemInput{
				RequestID:   fmt.Sprintf("cap_size_%d", i),
				Kind:        "payment",
				Description: "P",
				Lines: []journal.LineInput{
					{
						DebitAccountReference:  fixture.platform.Cash.Reference,
						CreditAccountReference: fixture.payable.Reference,
						Amount:                 100,
						Purpose:                "P",
					},
				},
			}
		}
		_, err := fixture.store.PostEntries(t.Context(), journal.BatchInput{
			LedgerSlug: fixture.slug,
			Entries:    entries,
		})
		if !errors.Is(err, journal.ErrBatchSizeExceeded) {
			t.Errorf("err = %v, want ErrBatchSizeExceeded", err)
		}
	})

	t.Run("batch lines exceeded fails whole batch with ErrBatchLinesExceeded", func(t *testing.T) {
		fixture := newPostEntryFixture(t)
		// 51 entries with 100 lines each = 5,100 lines (exceeds MaxBatchLines 5,000)
		entries := make([]journal.BatchItemInput, 51)
		for i := range entries {
			lines := make([]journal.LineInput, 100)
			for j := range lines {
				lines[j] = journal.LineInput{
					DebitAccountReference:  fixture.platform.Cash.Reference,
					CreditAccountReference: fixture.payable.Reference,
					Amount:                 100,
					Purpose:                "P",
				}
			}
			entries[i] = journal.BatchItemInput{
				RequestID:   fmt.Sprintf("cap_lines_%d", i),
				Kind:        "payment",
				Description: "P",
				Lines:       lines,
			}
		}
		_, err := fixture.store.PostEntries(t.Context(), journal.BatchInput{
			LedgerSlug: fixture.slug,
			Entries:    entries,
		})
		if !errors.Is(err, journal.ErrBatchLinesExceeded) {
			t.Errorf("err = %v, want ErrBatchLinesExceeded", err)
		}
	})
}

// TestStore_PostEntries_ConcurrentSameKey verifies that two concurrent batches
// sharing an idempotency key post it once: one gets created, the other existing.
func TestStore_PostEntries_ConcurrentSameKey(t *testing.T) {
	fixture := newCommittedPostEntryFixture(t)

	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()

	store1 := postgres.New(testDB)
	store2 := postgres.New(testDB)

	batch := journal.BatchInput{
		LedgerSlug: fixture.slug,
		Entries: padBatch(fixture.platform, "b11", []journal.BatchItemInput{
			{
				RequestID:   "concurrent_shared_key",
				Kind:        "payment",
				Description: "Shared payment key",
				Lines: []journal.LineInput{
					{
						DebitAccountReference:  fixture.platform.Cash.Reference,
						CreditAccountReference: fixture.payable.Reference,
						Amount:                 5000,
						Purpose:                "Shared payment",
					},
				},
			},
		}),
	}

	type outcome struct {
		result journal.BatchResult
		err    error
	}
	ch := make(chan outcome, 2)

	go func() {
		res, err := store1.PostEntries(ctx, batch)
		ch <- outcome{result: res, err: err}
	}()
	go func() {
		res, err := store2.PostEntries(ctx, batch)
		ch <- outcome{result: res, err: err}
	}()

	out1 := <-ch
	out2 := <-ch

	if out1.err != nil {
		t.Fatalf("out1 error: %v", out1.err)
	}
	if out2.err != nil {
		t.Fatalf("out2 error: %v", out2.err)
	}

	statuses := []journal.BatchItemStatus{
		out1.result.Results[0].Status,
		out2.result.Results[0].Status,
	}
	hasCreated := statuses[0] == journal.BatchItemCreated || statuses[1] == journal.BatchItemCreated
	hasExisting := statuses[0] == journal.BatchItemExisting || statuses[1] == journal.BatchItemExisting

	if !hasCreated || !hasExisting {
		t.Errorf("concurrent statuses = %v, want one created and one existing", statuses)
	}

	// Verify only 1 journal entry exists
	var count int
	err := testDB.QueryRowContext(ctx, `SELECT count(*) FROM journal_entries WHERE ledger_id = $1 AND request_id = $2`, fixture.ledgerID, "concurrent_shared_key").Scan(&count)
	if err != nil {
		t.Fatalf("count entries: %v", err)
	}
	if count != 1 {
		t.Errorf("count = %d, want 1", count)
	}
}

// TestStore_PostEntries_ConcurrentSharingAccounts verifies that two concurrent batches
// touching the same payable account both complete with gapless consecutive sequences.
func TestStore_PostEntries_ConcurrentSharingAccounts(t *testing.T) {
	fixture := newCommittedPostEntryFixture(t)

	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()

	store1 := postgres.New(testDB)
	store2 := postgres.New(testDB)

	batch1 := journal.BatchInput{
		LedgerSlug: fixture.slug,
		Entries: padBatch(fixture.platform, "b12", []journal.BatchItemInput{
			{
				RequestID:   "concurrent_b1_1",
				Kind:        "payment",
				Description: "B1 Leg 1",
				Lines: []journal.LineInput{
					{
						DebitAccountReference:  fixture.platform.Cash.Reference,
						CreditAccountReference: fixture.payable.Reference,
						Amount:                 1000,
						Purpose:                "P",
					},
				},
			},
			{
				RequestID:   "concurrent_b1_2",
				Kind:        "payment",
				Description: "B1 Leg 2",
				Lines: []journal.LineInput{
					{
						DebitAccountReference:  fixture.platform.Cash.Reference,
						CreditAccountReference: fixture.payable.Reference,
						Amount:                 2000,
						Purpose:                "P",
					},
				},
			},
		}),
	}

	batch2 := journal.BatchInput{
		LedgerSlug: fixture.slug,
		Entries: padBatch(fixture.platform, "b13", []journal.BatchItemInput{
			{
				RequestID:   "concurrent_b2_1",
				Kind:        "payment",
				Description: "B2 Leg 1",
				Lines: []journal.LineInput{
					{
						DebitAccountReference:  fixture.platform.Cash.Reference,
						CreditAccountReference: fixture.payable.Reference,
						Amount:                 3000,
						Purpose:                "P",
					},
				},
			},
			{
				RequestID:   "concurrent_b2_2",
				Kind:        "payment",
				Description: "B2 Leg 2",
				Lines: []journal.LineInput{
					{
						DebitAccountReference:  fixture.platform.Cash.Reference,
						CreditAccountReference: fixture.payable.Reference,
						Amount:                 4000,
						Purpose:                "P",
					},
				},
			},
		}),
	}

	errCh := make(chan error, 2)
	go func() {
		_, err := store1.PostEntries(ctx, batch1)
		errCh <- err
	}()
	go func() {
		_, err := store2.PostEntries(ctx, batch2)
		errCh <- err
	}()

	if err := <-errCh; err != nil {
		t.Fatalf("batch 1 error: %v", err)
	}
	if err := <-errCh; err != nil {
		t.Fatalf("batch 2 error: %v", err)
	}

	// Verify account movements have consecutive sequences 1, 2, 3, 4
	rows, err := testDB.QueryContext(ctx, `SELECT sequence FROM account_movements WHERE account_id = $1 ORDER BY sequence`, fixture.payable.ID)
	if err != nil {
		t.Fatalf("query movements: %v", err)
	}
	defer rows.Close()

	var sequences []int64
	for rows.Next() {
		var s int64
		if err := rows.Scan(&s); err != nil {
			t.Fatalf("scan sequence: %v", err)
		}
		sequences = append(sequences, s)
	}

	if err := rows.Err(); err != nil {
		t.Fatalf("read movements: %v", err)
	}

	if len(sequences) != 4 {
		t.Fatalf("sequences len = %d, want 4", len(sequences))
	}
	for i, s := range sequences {
		if s != int64(i+1) {
			t.Errorf("sequence[%d] = %d, want %d", i, s, i+1)
		}
	}
}

// TestStore_PostEntries_EffectiveAtMatchesStoredRow verifies that when effective_at is omitted,
// the returned effective_at matches the stored row in journal_entries exactly, and that
// replaying the entry returns the identical stored effective_at.
func TestStore_PostEntries_EffectiveAtMatchesStoredRow(t *testing.T) {
	fixture := newPostEntryFixture(t)

	// Single entry via PostEntry
	res, err := fixture.store.PostEntry(t.Context(), journal.PostInput{
		LedgerSlug:  fixture.slug,
		RequestID:   "eff_single",
		Kind:        "payment",
		Description: "Effective time test",
		EffectiveAt: nil, // omitted
		Lines: []journal.LineInput{
			{
				DebitAccountReference:  fixture.platform.Cash.Reference,
				CreditAccountReference: fixture.payable.Reference,
				Amount:                 1000,
				Purpose:                "P",
			},
		},
	})
	if err != nil {
		t.Fatalf("PostEntry failed: %v", err)
	}

	var storedEffectiveAt time.Time
	err = fixture.tx.QueryRowContext(
		t.Context(),
		`SELECT effective_at FROM journal_entries WHERE public_ref = $1`,
		res.Entry.Reference,
	).Scan(&storedEffectiveAt)
	if err != nil {
		t.Fatalf("query stored effective_at: %v", err)
	}

	if !res.Entry.EffectiveAt.Equal(storedEffectiveAt) {
		t.Errorf("PostEntry EffectiveAt = %v, want stored %v", res.Entry.EffectiveAt, storedEffectiveAt)
	}

	// Replay PostEntry
	replayRes, err := fixture.store.PostEntry(t.Context(), journal.PostInput{
		LedgerSlug:  fixture.slug,
		RequestID:   "eff_single",
		Kind:        "payment",
		Description: "Effective time test",
		EffectiveAt: nil,
		Lines: []journal.LineInput{
			{
				DebitAccountReference:  fixture.platform.Cash.Reference,
				CreditAccountReference: fixture.payable.Reference,
				Amount:                 1000,
				Purpose:                "P",
			},
		},
	})
	if err != nil {
		t.Fatalf("PostEntry replay failed: %v", err)
	}
	if !replayRes.Entry.EffectiveAt.Equal(storedEffectiveAt) {
		t.Errorf("PostEntry replay EffectiveAt = %v, want stored %v", replayRes.Entry.EffectiveAt, storedEffectiveAt)
	}
}

// padBatch appends inert filler entries so a test batch reaches the routine's
// minimum size. The filler moves one minor unit between the two platform
// accounts, neither of which tracks a balance, so it writes no movements and
// changes no counters that a test asserts on. Its request IDs are derived from
// tag, so re-sending a padded batch re-sends the same filler and stays
// idempotent.
func padBatch(platform platformAccounts, tag string, entries []journal.BatchItemInput) []journal.BatchItemInput {
	for i := len(entries); i < journal.MinBatchEntries; i++ {
		entries = append(entries, journal.BatchItemInput{
			RequestID:   fmt.Sprintf("pad_%s_%d", tag, i),
			Kind:        "adjustment",
			Description: "Batch filler",
			Lines: []journal.LineInput{
				{
					DebitAccountReference:  platform.Cash.Reference,
					CreditAccountReference: platform.FeeRevenue.Reference,
					Amount:                 1,
					Purpose:                "Filler",
				},
			},
		})
	}
	return entries
}

// TestStore_PostEntries_RejectsBatchBelowMinimum verifies the routine refuses a
// batch small enough that PostEntry would be the faster route for it.
func TestStore_PostEntries_RejectsBatchBelowMinimum(t *testing.T) {
	fixture := newPostEntryFixture(t)

	entries := make([]journal.BatchItemInput, journal.MinBatchEntries-1)
	for i := range entries {
		entries[i] = journal.BatchItemInput{
			RequestID:   fmt.Sprintf("small_%d", i),
			Kind:        "payment",
			Description: "Below the minimum",
			Lines: []journal.LineInput{
				{
					DebitAccountReference:  fixture.platform.Cash.Reference,
					CreditAccountReference: fixture.payable.Reference,
					Amount:                 100,
					Purpose:                "Card payment",
				},
			},
		}
	}

	_, err := fixture.store.PostEntries(t.Context(), journal.BatchInput{
		LedgerSlug: fixture.slug,
		Entries:    entries,
	})
	// The routine raises, so the transaction is aborted and nothing it might
	// have written can survive; there is no post-state left to assert on.
	if !errors.Is(err, journal.ErrBatchTooSmall) {
		t.Errorf("err = %v, want ErrBatchTooSmall", err)
	}
}

// TestStore_PostEntry_And_PostEntries_AgreeOnState posts the same entries one
// at a time and as a batch, into two accounts that start identical, and
// compares what each leaves behind. The two routines are separate
// implementations sharing only their fingerprint, limit arithmetic and entry
// totals; this is what catches the rest of them drifting apart.
func TestStore_PostEntry_And_PostEntries_AgreeOnState(t *testing.T) {
	fixture := newPostEntryFixture(t)

	batched, err := fixture.store.CreatePayableAccount(t.Context(), account.CreatePayableInput{
		LedgerSlug: fixture.slug,
		ExternalID: "merchant_2",
		Name:       "Batch Ltd",
	})
	if err != nil {
		t.Fatalf("create second payable account: %v", err)
	}
	single := fixture.payable.Reference

	// Payments in, then a smaller payout out, so both counters and several
	// movements per account are exercised.
	type step struct {
		kind    string
		amount  int64
		payout  bool
		purpose string
	}
	steps := make([]step, journal.MinBatchEntries)
	for i := range steps {
		steps[i] = step{kind: "payment", amount: int64(1000 * (i + 1)), purpose: "Card payment"}
	}
	steps[len(steps)-1] = step{kind: "payout", amount: 500, payout: true, purpose: "Payout"}

	lines := func(ref string, s step) []journal.LineInput {
		if s.payout {
			return []journal.LineInput{{
				DebitAccountReference:  ref,
				CreditAccountReference: fixture.platform.Cash.Reference,
				Amount:                 s.amount,
				Purpose:                s.purpose,
			}}
		}
		return []journal.LineInput{{
			DebitAccountReference:  fixture.platform.Cash.Reference,
			CreditAccountReference: ref,
			Amount:                 s.amount,
			Purpose:                s.purpose,
		}}
	}

	for i, s := range steps {
		fixture.mustPost(t, journal.PostInput{
			LedgerSlug:  fixture.slug,
			RequestID:   fmt.Sprintf("single_%d", i),
			Kind:        s.kind,
			Description: "Agreement check",
			Lines:       lines(single, s),
		})
	}

	batchEntries := make([]journal.BatchItemInput, len(steps))
	for i, s := range steps {
		batchEntries[i] = journal.BatchItemInput{
			RequestID:   fmt.Sprintf("batched_%d", i),
			Kind:        s.kind,
			Description: "Agreement check",
			Lines:       lines(batched.Account.Reference, s),
		}
	}

	result, err := fixture.store.PostEntries(t.Context(), journal.BatchInput{
		LedgerSlug: fixture.slug,
		Entries:    batchEntries,
	})
	if err != nil {
		t.Fatalf("PostEntries() error = %v", err)
	}
	for i, r := range result.Results {
		if r.Status != journal.BatchItemCreated {
			t.Fatalf("batch result %d = %s (%v), want created", i, r.Status, r.Error)
		}
	}

	singleAccount := lookupSeededAccount(t, fixture.tx, single)
	batchedAccount := lookupSeededAccount(t, fixture.tx, batched.Account.Reference)

	if got, want := readAccountBalances(t, fixture.tx, batchedAccount.ID), readAccountBalances(t, fixture.tx, singleAccount.ID); got != want {
		t.Errorf("counters after batch = %+v, after singles = %+v", got, want)
	}

	type movement struct {
		Sequence     int64
		Direction    string
		Amount       int64
		Purpose      string
		BalanceAfter int64
	}
	read := func(accountID int64) []movement {
		t.Helper()
		rows, err := fixture.tx.QueryContext(
			t.Context(),
			`SELECT sequence, direction, amount, purpose, balance_after
			   FROM account_movements WHERE account_id = $1 ORDER BY sequence`,
			accountID,
		)
		if err != nil {
			t.Fatalf("read movements: %v", err)
		}
		defer rows.Close()

		var out []movement
		for rows.Next() {
			var m movement
			if err := rows.Scan(&m.Sequence, &m.Direction, &m.Amount, &m.Purpose, &m.BalanceAfter); err != nil {
				t.Fatalf("scan movement: %v", err)
			}
			out = append(out, m)
		}
		if err := rows.Err(); err != nil {
			t.Fatalf("read movements: %v", err)
		}
		return out
	}

	fromSingles, fromBatch := read(singleAccount.ID), read(batchedAccount.ID)
	if len(fromSingles) != len(steps) {
		t.Fatalf("single path wrote %d movements, want %d", len(fromSingles), len(steps))
	}
	if !slices.Equal(fromSingles, fromBatch) {
		t.Errorf("movements differ:\n  singles = %+v\n  batch   = %+v", fromSingles, fromBatch)
	}
}

// TestPostRoutines_ShareLockOrder guards the phase ordering the two routines
// must agree on. Both claim request ids before locking the accounts they touch.
// Opposite orders would let one transaction hold an id while reaching for an
// account another holds, while the other reaches for that id: Postgres aborts
// one with 40P01 and the caller gets a 500 where an idempotent outcome was due.
//
// A large batch is what makes the window wide enough to hit: it takes its
// account locks, then spends the limit loop before inserting anything.
func TestPostRoutines_ShareLockOrder(t *testing.T) {
	const (
		attempts  = 3
		batchSize = 800
	)

	for attempt := range attempts {
		fixture := newCommittedPostEntryFixture(t)
		sharedKey := fmt.Sprintf("shared_%d_%d", time.Now().UnixNano(), attempt)

		entries := make([]journal.BatchItemInput, batchSize)
		for i := range entries {
			key := fmt.Sprintf("%s_filler_%d", sharedKey, i)
			if i == batchSize-1 {
				key = sharedKey
			}
			entries[i] = journal.BatchItemInput{
				RequestID:   key,
				Kind:        "payment",
				Description: "Lock order probe",
				Lines: []journal.LineInput{
					{
						DebitAccountReference:  fixture.platform.Cash.Reference,
						CreditAccountReference: fixture.payable.Reference,
						Amount:                 100,
						Purpose:                "Card payment",
					},
				},
			}
		}

		ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)

		var (
			wg                  sync.WaitGroup
			batchErr, singleErr error
		)

		wg.Add(2)
		go func() {
			defer wg.Done()
			_, batchErr = postgres.New(testDB).PostEntries(ctx, journal.BatchInput{
				LedgerSlug: fixture.slug,
				Entries:    entries,
			})
		}()
		go func() {
			defer wg.Done()
			// Start while the batch is still processing its large request-id
			// claim set, making either routine a plausible winner of the shared
			// key without allowing a lock-order cycle.
			time.Sleep(15 * time.Millisecond)
			_, singleErr = postgres.New(testDB).PostEntry(ctx, journal.PostInput{
				LedgerSlug:  fixture.slug,
				RequestID:   sharedKey,
				Kind:        "payment",
				Description: "Lock order probe",
				Lines: []journal.LineInput{
					{
						DebitAccountReference:  fixture.platform.Cash.Reference,
						CreditAccountReference: fixture.payable.Reference,
						Amount:                 100,
						Purpose:                "Card payment",
					},
				},
			})
		}()
		wg.Wait()
		cancel()

		for name, err := range map[string]error{"batch": batchErr, "single": singleErr} {
			if err != nil && strings.Contains(err.Error(), "40P01") {
				t.Fatalf("attempt %d: %s deadlocked: %v", attempt, name, err)
			}
		}

		var posted int
		if err := testDB.QueryRowContext(
			t.Context(),
			`SELECT count(*) FROM journal_entries WHERE ledger_id = $1 AND request_id = $2`,
			fixture.ledgerID, sharedKey,
		).Scan(&posted); err != nil {
			t.Fatalf("count shared key: %v", err)
		}
		if posted != 1 {
			t.Errorf("attempt %d: shared key posted %d times, want 1", attempt, posted)
		}
	}
}

// TestStore_PostEntries_SerializesIdempotencyBeforeBalances proves request ids
// are their own lock domain. The competing use of the shared key touches only
// untracked platform accounts, while the batch's version credits a limited
// payable account. Account locks therefore cannot serialize the conflict. The
// request lock must make the batch classify it before simulating balances, or
// the following debit would be admitted against a credit that will not post.
func TestStore_PostEntries_SerializesIdempotencyBeforeBalances(t *testing.T) {
	fixture := newCommittedPostEntryFixture(t)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()

	key := fmt.Sprintf("shared_credit_%d", time.Now().UnixNano())

	// Transaction A claims the key using different content and accounts, then
	// remains open so the batch has to wait for the request lock.
	txA, err := testDB.BeginTx(ctx, nil)
	if err != nil {
		t.Fatalf("begin transaction A: %v", err)
	}
	defer txA.Rollback() //nolint:errcheck // rolled back only if the commit below did not run

	if _, err := postgres.New(txA).PostEntry(ctx, journal.PostInput{
		LedgerSlug:  fixture.slug,
		RequestID:   key,
		Kind:        "adjustment",
		Description: "Competing use on unrelated accounts",
		Lines: []journal.LineInput{
			{
				DebitAccountReference:  fixture.platform.Cash.Reference,
				CreditAccountReference: fixture.platform.FeeRevenue.Reference,
				Amount:                 7,
				Purpose:                "Adjustment",
			},
		},
	}); err != nil {
		t.Fatalf("transaction A PostEntry: %v", err)
	}

	entries := padBatch(fixture.platform, "request_lock", []journal.BatchItemInput{
		{
			RequestID:   key,
			Kind:        "payment",
			Description: "Shared credit",
			Lines: []journal.LineInput{
				{
					DebitAccountReference:  fixture.platform.Cash.Reference,
					CreditAccountReference: fixture.payable.Reference,
					Amount:                 1000,
					Purpose:                "Card payment",
				},
			},
		},
		{
			RequestID:   key + "_debit",
			Kind:        "payout",
			Description: "Only fits if the credit is counted twice",
			Lines: []journal.LineInput{
				{
					DebitAccountReference:  fixture.payable.Reference,
					CreditAccountReference: fixture.platform.Cash.Reference,
					Amount:                 1500,
					Purpose:                "Payout",
				},
			},
		},
	})

	txB, err := testDB.BeginTx(ctx, nil)
	if err != nil {
		t.Fatalf("begin transaction B: %v", err)
	}
	defer txB.Rollback() //nolint:errcheck // rolled back only if the commit below did not run

	var batchPID int
	if err := txB.QueryRowContext(ctx, `SELECT pg_backend_pid()`).Scan(&batchPID); err != nil {
		t.Fatalf("read batch backend PID: %v", err)
	}

	type outcome struct {
		result journal.BatchResult
		err    error
	}
	done := make(chan outcome, 1)
	go func() {
		result, err := postgres.New(txB).PostEntries(ctx, journal.BatchInput{
			LedgerSlug: fixture.slug,
			Entries:    entries,
		})
		done <- outcome{result, err}
	}()

	for {
		var waitEventType sql.NullString
		if err := testDB.QueryRowContext(
			ctx,
			`SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1`,
			batchPID,
		).Scan(&waitEventType); err != nil {
			t.Fatalf("inspect batch lock state: %v", err)
		}
		if waitEventType.Valid && waitEventType.String == "Lock" {
			break
		}
		select {
		case got := <-done:
			t.Fatalf("batch completed before waiting for request lock: %v", got.err)
		case <-ctx.Done():
			t.Fatalf("wait for batch request lock: %v", context.Cause(ctx))
		case <-time.After(5 * time.Millisecond):
		}
	}

	if err := txA.Commit(); err != nil {
		t.Fatalf("transaction A commit: %v", err)
	}

	got := <-done
	if got.err != nil {
		t.Fatalf("PostEntries() error = %v, want the batch to survive", got.err)
	}
	if r := got.result.Results[0]; r.Status != journal.BatchItemRejected ||
		r.Error == nil || r.Error.Code != "idempotency_conflict" {
		t.Errorf("shared key result = %s %v, want rejected idempotency_conflict", r.Status, r.Error)
	}
	if r := got.result.Results[1]; r.Status != journal.BatchItemRejected ||
		r.Error == nil || r.Error.Code != "insufficient_funds" {
		t.Errorf("debit result = %s %v, want rejected insufficient_funds", r.Status, r.Error)
	}
	if err := txB.Commit(); err != nil {
		t.Fatalf("commit batch transaction: %v", err)
	}

	var credits, debits int64
	if err := testDB.QueryRowContext(ctx,
		`SELECT credits_posted, debits_posted FROM accounts WHERE id = $1`, fixture.payable.ID,
	).Scan(&credits, &debits); err != nil {
		t.Fatalf("read counters: %v", err)
	}
	if credits != 0 || debits != 0 {
		t.Errorf("counters = credits %d debits %d, want both zero", credits, debits)
	}
}

// TestStore_PostEntries_RechecksClosureAfterLocking covers a closure that is
// still uncommitted when the batch would otherwise check it. The batch must
// not read the account as open, wait for the lock the closure holds, and then
// post to it. Both routines check closure after taking the lock, so both
// reject the entry.
func TestStore_PostEntries_RechecksClosureAfterLocking(t *testing.T) {
	for _, tc := range []struct {
		name string
		post func(t *testing.T, fixture committedPostEntryFixture, requestID string) (journal.BatchItemStatus, error)
	}{
		{
			name: "batch",
			post: func(t *testing.T, fixture committedPostEntryFixture, requestID string) (journal.BatchItemStatus, error) {
				entries := padBatch(fixture.platform, requestID, []journal.BatchItemInput{{
					RequestID:   requestID,
					Kind:        "payment",
					Description: "Posted while the account closes",
					Lines:       closingAccountLines(fixture),
				}})
				result, err := postgres.New(testDB).PostEntries(t.Context(), journal.BatchInput{
					LedgerSlug: fixture.slug,
					Entries:    entries,
				})
				if err != nil {
					return "", err
				}
				return result.Results[0].Status, nil
			},
		},
		{
			name: "single",
			post: func(t *testing.T, fixture committedPostEntryFixture, requestID string) (journal.BatchItemStatus, error) {
				_, err := postgres.New(testDB).PostEntry(t.Context(), journal.PostInput{
					LedgerSlug:  fixture.slug,
					RequestID:   requestID,
					Kind:        "payment",
					Description: "Posted while the account closes",
					Lines:       closingAccountLines(fixture),
				})
				if errors.Is(err, journal.ErrAccountClosed) {
					return journal.BatchItemRejected, nil
				}
				return journal.BatchItemCreated, err
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fixture := newCommittedPostEntryFixture(t)
			ctx := t.Context()
			requestID := fmt.Sprintf("closing_%s_%d", tc.name, time.Now().UnixNano())

			closing, err := testDB.BeginTx(ctx, nil)
			if err != nil {
				t.Fatalf("begin closing transaction: %v", err)
			}
			defer closing.Rollback() //nolint:errcheck // rolled back only if the commit below did not run

			if _, err := closing.ExecContext(ctx,
				`UPDATE accounts SET closed_at = clock_timestamp() WHERE id = $1`, fixture.payable.ID); err != nil {
				t.Fatalf("close account: %v", err)
			}

			type outcome struct {
				status journal.BatchItemStatus
				err    error
			}
			done := make(chan outcome, 1)
			go func() {
				status, err := tc.post(t, fixture, requestID)
				done <- outcome{status, err}
			}()

			// Long enough for the posting to reach the account lock.
			time.Sleep(150 * time.Millisecond)
			if err := closing.Commit(); err != nil {
				t.Fatalf("commit closure: %v", err)
			}

			got := <-done
			if got.err != nil {
				t.Fatalf("post error = %v", got.err)
			}
			if got.status != journal.BatchItemRejected {
				t.Errorf("status = %s, want rejected", got.status)
			}

			var posted int
			if err := testDB.QueryRowContext(ctx,
				`SELECT count(*) FROM journal_entries WHERE request_id = $1`, requestID).Scan(&posted); err != nil {
				t.Fatalf("count entries: %v", err)
			}
			if posted != 0 {
				t.Errorf("posted %d entries to a closed account, want 0", posted)
			}
		})
	}
}

func closingAccountLines(fixture committedPostEntryFixture) []journal.LineInput {
	return []journal.LineInput{
		{
			DebitAccountReference:  fixture.platform.Cash.Reference,
			CreditAccountReference: fixture.payable.Reference,
			Amount:                 1000,
			Purpose:                "Card payment",
		},
	}
}

// TestStore_PostEntries_ClaimsRequestIdsInOneOrder covers the sort on the
// claiming insert. Two batches holding the same keys in opposite order would
// otherwise each hold one the other wants, and Postgres would abort one with
// 40P01. Sorting gives every batch the same claim order, so the second waits
// instead of deadlocking. A thousand keys is what makes the claims overlap;
// a handful finish too fast to collide.
func TestStore_PostEntries_ClaimsRequestIdsInOneOrder(t *testing.T) {
	fixture := newCommittedPostEntryFixture(t)
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()

	run := fmt.Sprintf("claim_order_%d", time.Now().UnixNano())
	keys := make([]string, journal.MaxBatchEntries)
	for i := range keys {
		keys[i] = fmt.Sprintf("%s_%04d", run, i)
	}

	build := func(order []string) []journal.BatchItemInput {
		entries := make([]journal.BatchItemInput, len(order))
		for i, key := range order {
			entries[i] = journal.BatchItemInput{
				RequestID:   key,
				Kind:        "payment",
				Description: "Claim order " + key,
				Lines: []journal.LineInput{
					{
						DebitAccountReference:  fixture.platform.Cash.Reference,
						CreditAccountReference: fixture.payable.Reference,
						Amount:                 100,
						Purpose:                "Card payment",
					},
				},
			}
		}
		return entries
	}

	reversed := slices.Clone(keys)
	slices.Reverse(reversed)

	var wg sync.WaitGroup
	errs := make([]error, 2)
	for i, entries := range [][]journal.BatchItemInput{build(keys), build(reversed)} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, errs[i] = postgres.New(testDB).PostEntries(ctx, journal.BatchInput{
				LedgerSlug: fixture.slug,
				Entries:    entries,
			})
		}()
	}
	wg.Wait()

	for i, err := range errs {
		if err != nil {
			t.Errorf("batch %d failed: %v", i, err)
		}
	}

	// Whichever claimed first posted them; the other saw every key as existing.
	var posted int
	if err := testDB.QueryRowContext(ctx,
		`SELECT count(*) FROM journal_entries WHERE ledger_id = $1 AND request_id LIKE $2`,
		fixture.ledgerID, run+"%",
	).Scan(&posted); err != nil {
		t.Fatalf("count posted entries: %v", err)
	}
	if posted != len(keys) {
		t.Errorf("posted %d entries, want %d", posted, len(keys))
	}
}
