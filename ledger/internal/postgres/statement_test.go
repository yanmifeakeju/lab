//go:build integration

package postgres_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"yanmifeakeju.com/ledger/internal/account"
	"yanmifeakeju.com/ledger/internal/journal"
	"yanmifeakeju.com/ledger/internal/postgres"
	"yanmifeakeju.com/ledger/internal/statement"
)

func TestStore_GetStatement_HappyPath(t *testing.T) {
	fixture := newPostEntryFixture(t)
	store := postgres.New(fixture.tx)

	// Create 2 payments for the payable account.
	// Entry 1: 10,000 credit to payable, 200 fee debit from payable
	desc1 := "Payment received"
	eff1 := time.Date(2026, time.September, 10, 9, 15, 0, 0, time.UTC)
	entry1 := fixture.mustPost(t, journal.PostInput{
		LedgerSlug:  "ngn_ng",
		RequestID:   "req_1",
		Kind:        journal.KindPayment,
		Description: &desc1,
		EffectiveAt: &eff1,
		Lines: []journal.LineInput{
			{
				DebitAccountReference:  fixture.platform.Cash.Reference,
				CreditAccountReference: fixture.payable.Reference,
				Amount:                 9_800,
			},
			{
				DebitAccountReference:  fixture.payable.Reference,
				CreditAccountReference: fixture.platform.FeeRevenue.Reference,
				Amount:                 200,
			},
		},
	})

	// Query statement period covering entry1.
	from := entry1.Entry.CreatedAt.Add(-24 * time.Hour)
	to := entry1.Entry.CreatedAt.Add(24 * time.Hour)

	res, err := store.GetStatement(t.Context(), statement.ListInput{
		LedgerSlug:       "ngn_ng",
		AccountReference: fixture.payable.Reference,
		From:             from,
		To:               to,
		Limit:            50,
	})
	if err != nil {
		t.Fatalf("GetStatement() error = %v", err)
	}

	if res.Account.Reference != fixture.payable.Reference {
		t.Errorf("Account.Reference = %q, want %q", res.Account.Reference, fixture.payable.Reference)
	}
	if res.OpeningBalance != 0 {
		t.Errorf("OpeningBalance = %d, want 0", res.OpeningBalance)
	}
	// 9800 credit - 200 debit = 9600
	if res.ClosingBalance != 9600 {
		t.Errorf("ClosingBalance = %d, want 9600", res.ClosingBalance)
	}
	if len(res.Movements) != 2 {
		t.Fatalf("len(Movements) = %d, want 2", len(res.Movements))
	}

	// Line 1: Credit 9800, balance_after = 9800
	m1 := res.Movements[0]
	if m1.JournalReference != entry1.Entry.Reference {
		t.Errorf("m1.JournalReference = %q, want %q", m1.JournalReference, entry1.Entry.Reference)
	}
	if m1.LineNumber != 1 {
		t.Errorf("m1.LineNumber = %d, want 1", m1.LineNumber)
	}
	if m1.Direction != statement.DirectionCredit {
		t.Errorf("m1.Direction = %q, want %q", m1.Direction, statement.DirectionCredit)
	}
	if m1.Amount != 9800 {
		t.Errorf("m1.Amount = %d, want 9800", m1.Amount)
	}
	if m1.BalanceAfter != 9800 {
		t.Errorf("m1.BalanceAfter = %d, want 9800", m1.BalanceAfter)
	}

	// Line 2: Debit 200, balance_after = 9600
	m2 := res.Movements[1]
	if m2.JournalReference != entry1.Entry.Reference {
		t.Errorf("m2.JournalReference = %q, want %q", m2.JournalReference, entry1.Entry.Reference)
	}
	if m2.LineNumber != 2 {
		t.Errorf("m2.LineNumber = %d, want 2", m2.LineNumber)
	}
	if m2.Direction != statement.DirectionDebit {
		t.Errorf("m2.Direction = %q, want %q", m2.Direction, statement.DirectionDebit)
	}
	if m2.Amount != 200 {
		t.Errorf("m2.Amount = %d, want 200", m2.Amount)
	}
	if m2.BalanceAfter != 9600 {
		t.Errorf("m2.BalanceAfter = %d, want 9600", m2.BalanceAfter)
	}
}

// TestStore_GetStatement_TimelineStability verifies that recorded-time ordering
// remains stable when a newly recorded entry carries an earlier effective_at value.
func TestStore_GetStatement_TimelineStability(t *testing.T) {
	fixture := newPostEntryFixture(t)
	store := postgres.New(fixture.tx)

	// Entry 1: effective Sept 15, posted first
	eff1 := time.Date(2026, time.September, 15, 0, 0, 0, 0, time.UTC)
	entry1 := fixture.mustPost(t, journal.PostInput{
		LedgerSlug:  "ngn_ng",
		RequestID:   "req_timeline_1",
		Kind:        journal.KindPayment,
		EffectiveAt: &eff1,
		Lines: []journal.LineInput{
			{
				DebitAccountReference:  fixture.platform.Cash.Reference,
				CreditAccountReference: fixture.payable.Reference,
				Amount:                 1_000,
			},
		},
	})

	// Entry 2: effective Sept 1 (earlier effective time), posted second
	eff2 := time.Date(2026, time.September, 1, 0, 0, 0, 0, time.UTC)
	entry2 := fixture.mustPost(t, journal.PostInput{
		LedgerSlug:  "ngn_ng",
		RequestID:   "req_timeline_2",
		Kind:        journal.KindPayment,
		EffectiveAt: &eff2,
		Lines: []journal.LineInput{
			{
				DebitAccountReference:  fixture.platform.Cash.Reference,
				CreditAccountReference: fixture.payable.Reference,
				Amount:                 2_000,
			},
		},
	})

	res, err := store.GetStatement(t.Context(), statement.ListInput{
		LedgerSlug:       "ngn_ng",
		AccountReference: fixture.payable.Reference,
		From:             entry1.Entry.CreatedAt.Add(-24 * time.Hour),
		To:               entry2.Entry.CreatedAt.Add(24 * time.Hour),
		Limit:            10,
	})
	if err != nil {
		t.Fatalf("GetStatement() error = %v", err)
	}

	if len(res.Movements) != 2 {
		t.Fatalf("len(Movements) = %d, want 2", len(res.Movements))
	}

	// Both entries share the test transaction's created_at, so posting order
	// breaks the tie. entry1 must still come first despite its later effective_at.
	if res.Movements[0].JournalReference != entry1.Entry.Reference {
		t.Errorf("Movements[0] = %q, want entry1 %q", res.Movements[0].JournalReference, entry1.Entry.Reference)
	}
	if res.Movements[1].JournalReference != entry2.Entry.Reference {
		t.Errorf("Movements[1] = %q, want entry2 %q", res.Movements[1].JournalReference, entry2.Entry.Reference)
	}
}

// TestStore_GetStatement_BidirectionalPagination tests multi-page forward and
// backward navigation, ensuring round-trip symmetry and exact boundary handling.
func TestStore_GetStatement_BidirectionalPagination(t *testing.T) {
	fixture := newPostEntryFixture(t)
	store := postgres.New(fixture.tx)

	// Create 5 entries (1 movement each).
	var postedEntries []journal.PostResult
	for i := 1; i <= 5; i++ {
		eff := time.Date(2026, time.September, i, 12, 0, 0, 0, time.UTC)
		res := fixture.mustPost(t, journal.PostInput{
			LedgerSlug:  "ngn_ng",
			RequestID:   "req_page_" + string(rune('0'+i)),
			Kind:        journal.KindPayment,
			EffectiveAt: &eff,
			Lines: []journal.LineInput{
				{
					DebitAccountReference:  fixture.platform.Cash.Reference,
					CreditAccountReference: fixture.payable.Reference,
					Amount:                 int64(i * 100),
				},
			},
		})
		postedEntries = append(postedEntries, res)
	}

	from := postedEntries[0].Entry.CreatedAt.Add(-24 * time.Hour)
	to := postedEntries[len(postedEntries)-1].Entry.CreatedAt.Add(24 * time.Hour)
	limit := 2

	// Page 1: Should return entries 0 and 1
	page1, err := store.GetStatement(t.Context(), statement.ListInput{
		LedgerSlug:       "ngn_ng",
		AccountReference: fixture.payable.Reference,
		From:             from,
		To:               to,
		Limit:            limit,
	})
	if err != nil {
		t.Fatalf("Page 1 error: %v", err)
	}
	if len(page1.Movements) != 2 {
		t.Fatalf("Page 1 count = %d, want 2", len(page1.Movements))
	}
	if page1.Page.Previous != nil {
		t.Errorf("Page 1 Previous cursor = %v, want nil", page1.Page.Previous)
	}
	if page1.Page.Next == nil {
		t.Fatal("Page 1 Next cursor is nil, want non-nil")
	}
	if page1.Movements[0].JournalReference != postedEntries[0].Entry.Reference {
		t.Errorf("Page 1[0] = %q, want %q", page1.Movements[0].JournalReference, postedEntries[0].Entry.Reference)
	}
	if page1.Movements[1].JournalReference != postedEntries[1].Entry.Reference {
		t.Errorf("Page 1[1] = %q, want %q", page1.Movements[1].JournalReference, postedEntries[1].Entry.Reference)
	}

	// Page 2: Follow page1.Next -> should return entries 2 and 3
	page2, err := store.GetStatement(t.Context(), statement.ListInput{
		LedgerSlug:       "ngn_ng",
		AccountReference: fixture.payable.Reference,
		From:             from,
		To:               to,
		Limit:            limit,
		Cursor:           page1.Page.Next,
	})
	if err != nil {
		t.Fatalf("Page 2 error: %v", err)
	}
	if len(page2.Movements) != 2 {
		t.Fatalf("Page 2 count = %d, want 2", len(page2.Movements))
	}
	if page2.Page.Previous == nil {
		t.Errorf("Page 2 Previous cursor is nil, want non-nil")
	}
	if page2.Page.Next == nil {
		t.Errorf("Page 2 Next cursor is nil, want non-nil")
	}
	if page2.Movements[0].JournalReference != postedEntries[2].Entry.Reference {
		t.Errorf("Page 2[0] = %q, want %q", page2.Movements[0].JournalReference, postedEntries[2].Entry.Reference)
	}
	if page2.Movements[1].JournalReference != postedEntries[3].Entry.Reference {
		t.Errorf("Page 2[1] = %q, want %q", page2.Movements[1].JournalReference, postedEntries[3].Entry.Reference)
	}

	// Page 3: Follow page2.Next -> should return entry 4
	page3, err := store.GetStatement(t.Context(), statement.ListInput{
		LedgerSlug:       "ngn_ng",
		AccountReference: fixture.payable.Reference,
		From:             from,
		To:               to,
		Limit:            limit,
		Cursor:           page2.Page.Next,
	})
	if err != nil {
		t.Fatalf("Page 3 error: %v", err)
	}
	if len(page3.Movements) != 1 {
		t.Fatalf("Page 3 count = %d, want 1", len(page3.Movements))
	}
	if page3.Page.Previous == nil {
		t.Errorf("Page 3 Previous cursor is nil, want non-nil")
	}
	if page3.Page.Next != nil {
		t.Errorf("Page 3 Next cursor = %v, want nil (last page)", page3.Page.Next)
	}
	if page3.Movements[0].JournalReference != postedEntries[4].Entry.Reference {
		t.Errorf("Page 3[0] = %q, want %q", page3.Movements[0].JournalReference, postedEntries[4].Entry.Reference)
	}

	// Backtrack: from Page 2, follow page2.Previous -> MUST return Page 1 exactly!
	backToPage1, err := store.GetStatement(t.Context(), statement.ListInput{
		LedgerSlug:       "ngn_ng",
		AccountReference: fixture.payable.Reference,
		From:             from,
		To:               to,
		Limit:            limit,
		Cursor:           page2.Page.Previous,
	})
	if err != nil {
		t.Fatalf("Back to Page 1 error: %v", err)
	}
	if len(backToPage1.Movements) != 2 {
		t.Fatalf("Back to Page 1 count = %d, want 2", len(backToPage1.Movements))
	}
	if backToPage1.Page.Previous != nil {
		t.Errorf("Back to Page 1 Previous cursor = %v, want nil", backToPage1.Page.Previous)
	}
	if backToPage1.Movements[0].JournalReference != postedEntries[0].Entry.Reference {
		t.Errorf("Back to Page 1[0] = %q, want %q", backToPage1.Movements[0].JournalReference, postedEntries[0].Entry.Reference)
	}
	if backToPage1.Movements[1].JournalReference != postedEntries[1].Entry.Reference {
		t.Errorf("Back to Page 1[1] = %q, want %q", backToPage1.Movements[1].JournalReference, postedEntries[1].Entry.Reference)
	}
}

func TestStore_GetStatement_EmptyPeriod(t *testing.T) {
	fixture := newPostEntryFixture(t)
	store := postgres.New(fixture.tx)

	res, err := store.GetStatement(t.Context(), statement.ListInput{
		LedgerSlug:       "ngn_ng",
		AccountReference: fixture.payable.Reference,
		From:             time.Date(2025, time.January, 1, 0, 0, 0, 0, time.UTC),
		To:               time.Date(2025, time.February, 1, 0, 0, 0, 0, time.UTC),
		Limit:            50,
	})
	if err != nil {
		t.Fatalf("GetStatement() error = %v", err)
	}

	if len(res.Movements) != 0 {
		t.Errorf("len(Movements) = %d, want 0", len(res.Movements))
	}
	if res.OpeningBalance != 0 || res.ClosingBalance != 0 {
		t.Errorf("balances = (%d, %d), want (0, 0)", res.OpeningBalance, res.ClosingBalance)
	}
	if res.Page.Previous != nil || res.Page.Next != nil {
		t.Errorf("cursors = (%v, %v), want (nil, nil)", res.Page.Previous, res.Page.Next)
	}
}

func TestStore_GetStatement_Errors(t *testing.T) {
	fixture := newPostEntryFixture(t)
	store := postgres.New(fixture.tx)

	from := time.Date(2026, time.September, 1, 0, 0, 0, 0, time.UTC)
	to := time.Date(2026, time.October, 1, 0, 0, 0, 0, time.UTC)

	t.Run("ledger not found", func(t *testing.T) {
		_, err := store.GetStatement(t.Context(), statement.ListInput{
			LedgerSlug:       "nonexistent_ledger",
			AccountReference: fixture.payable.Reference,
			From:             from,
			To:               to,
			Limit:            50,
		})
		if !errors.Is(err, account.ErrLedgerNotFound) {
			t.Errorf("GetStatement() error = %v, want ErrLedgerNotFound", err)
		}
	})

	t.Run("account not found", func(t *testing.T) {
		_, err := store.GetStatement(t.Context(), statement.ListInput{
			LedgerSlug:       "ngn_ng",
			AccountReference: "acct_01K00000000000000000000000",
			From:             from,
			To:               to,
			Limit:            50,
		})
		if !errors.Is(err, account.ErrAccountNotFound) {
			t.Errorf("GetStatement() error = %v, want ErrAccountNotFound", err)
		}
	})

	t.Run("internal account returns account not found", func(t *testing.T) {
		_, err := store.GetStatement(t.Context(), statement.ListInput{
			LedgerSlug:       "ngn_ng",
			AccountReference: fixture.platform.Cash.Reference,
			From:             from,
			To:               to,
			Limit:            50,
		})
		if !errors.Is(err, account.ErrAccountNotFound) {
			t.Errorf("GetStatement() error = %v, want ErrAccountNotFound", err)
		}
	})

	t.Run("cancelled context returns context error instead of ledger not found", func(t *testing.T) {
		ctx, cancel := context.WithCancel(t.Context())
		cancel()

		_, err := store.GetStatement(ctx, statement.ListInput{
			LedgerSlug:       "ngn_ng",
			AccountReference: fixture.payable.Reference,
			From:             from,
			To:               to,
			Limit:            50,
		})
		if !errors.Is(err, context.Canceled) {
			t.Errorf("GetStatement() error = %v, want context.Canceled", err)
		}
		if errors.Is(err, account.ErrLedgerNotFound) {
			t.Errorf("GetStatement() incorrectly masked error as ErrLedgerNotFound")
		}
	})
}
