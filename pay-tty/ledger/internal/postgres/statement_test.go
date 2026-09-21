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
	store := postgres.NewWithStatementMargin(fixture.tx, 0)

	// Create 2 payments for the payable account.
	// Entry 1: 10,000 credit to payable, 200 fee debit from payable
	desc1 := "Payment received"
	eff1 := time.Date(2026, time.September, 10, 9, 15, 0, 0, time.UTC)
	entry1 := fixture.mustPost(t, journal.PostInput{
		LedgerSlug:  "ngn_ng",
		RequestID:   "req_1",
		Kind:        "payment",
		Description: desc1,
		EffectiveAt: &eff1,
		Lines: []journal.LineInput{
			{
				DebitAccountReference:  fixture.platform.Cash.Reference,
				CreditAccountReference: fixture.payable.Reference,
				Amount:                 9_800,
				Purpose:                "Card payment",
			},
			{
				DebitAccountReference:  fixture.payable.Reference,
				CreditAccountReference: fixture.platform.FeeRevenue.Reference,
				Amount:                 200,
				Purpose:                "Processing fee",
			},
		},
	})

	// Query statement period covering entry1.
	from := entry1.Entry.CreatedAt.Add(-24 * time.Hour)
	to := entry1.Entry.CreatedAt.Add(24 * time.Hour)

	res, err := store.GetStatement(t.Context(), statement.ListInput{
		AccountReference: fixture.payable.Reference,
		From:             new(from),
		To:               new(to),
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
	if m1.Kind != "payment" {
		t.Errorf("m1.Kind = %q, want payment", m1.Kind)
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
	if m1.Description != desc1 {
		t.Errorf("m1.Description = %q, want %q", m1.Description, desc1)
	}
	if m1.Purpose != "Card payment" {
		t.Errorf("m1.Purpose = %q, want Card payment", m1.Purpose)
	}

	// Line 2: Debit 200, balance_after = 9600
	m2 := res.Movements[1]
	if m2.JournalReference != entry1.Entry.Reference {
		t.Errorf("m2.JournalReference = %q, want %q", m2.JournalReference, entry1.Entry.Reference)
	}
	if m2.LineNumber != 2 {
		t.Errorf("m2.LineNumber = %d, want 2", m2.LineNumber)
	}
	if m2.Kind != "payment" {
		t.Errorf("m2.Kind = %q, want payment", m2.Kind)
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
	if m2.Description != desc1 {
		t.Errorf("m2.Description = %q, want %q", m2.Description, desc1)
	}
	if m2.Purpose != "Processing fee" {
		t.Errorf("m2.Purpose = %q, want Processing fee", m2.Purpose)
	}
}

// TestStore_GetStatement_TimelineStability verifies that recorded-time ordering
// remains stable when a newly recorded entry carries an earlier effective_at value.
func TestStore_GetStatement_TimelineStability(t *testing.T) {
	fixture := newPostEntryFixture(t)
	store := postgres.NewWithStatementMargin(fixture.tx, 0)

	// Entry 1: effective Sept 15, posted first
	eff1 := time.Date(2026, time.September, 15, 0, 0, 0, 0, time.UTC)
	entry1 := fixture.mustPost(t, journal.PostInput{
		LedgerSlug:  "ngn_ng",
		RequestID:   "req_timeline_1",
		Kind:        "payment",
		Description: "Timeline entry 1",
		EffectiveAt: &eff1,
		Lines: []journal.LineInput{
			{
				DebitAccountReference:  fixture.platform.Cash.Reference,
				CreditAccountReference: fixture.payable.Reference,
				Amount:                 1_000,
				Purpose:                "Timeline 1",
			},
		},
	})

	// Entry 2: effective Sept 1 (earlier effective time), posted second
	eff2 := time.Date(2026, time.September, 1, 0, 0, 0, 0, time.UTC)
	entry2 := fixture.mustPost(t, journal.PostInput{
		LedgerSlug:  "ngn_ng",
		RequestID:   "req_timeline_2",
		Kind:        "payment",
		Description: "Timeline entry 2",
		EffectiveAt: &eff2,
		Lines: []journal.LineInput{
			{
				DebitAccountReference:  fixture.platform.Cash.Reference,
				CreditAccountReference: fixture.payable.Reference,
				Amount:                 2_000,
				Purpose:                "Timeline 2",
			},
		},
	})

	res, err := store.GetStatement(t.Context(), statement.ListInput{
		AccountReference: fixture.payable.Reference,
		From:             new(entry1.Entry.CreatedAt.Add(-24 * time.Hour)),
		To:               new(entry2.Entry.CreatedAt.Add(24 * time.Hour)),
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
	store := postgres.NewWithStatementMargin(fixture.tx, 0)

	// Create 5 entries (1 movement each).
	var postedEntries []journal.PostResult
	for i := 1; i <= 5; i++ {
		eff := time.Date(2026, time.September, i, 12, 0, 0, 0, time.UTC)
		res := fixture.mustPost(t, journal.PostInput{
			LedgerSlug:  "ngn_ng",
			RequestID:   "req_page_" + string(rune('0'+i)),
			Kind:        "payment",
			Description: "Pagination entry",
			EffectiveAt: &eff,
			Lines: []journal.LineInput{
				{
					DebitAccountReference:  fixture.platform.Cash.Reference,
					CreditAccountReference: fixture.payable.Reference,
					Amount:                 int64(i * 100),
					Purpose:                "Pagination movement",
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
		AccountReference: fixture.payable.Reference,
		From:             new(from),
		To:               new(to),
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
		AccountReference: fixture.payable.Reference,
		From:             new(from),
		To:               new(to),
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
		AccountReference: fixture.payable.Reference,
		From:             new(from),
		To:               new(to),
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
		AccountReference: fixture.payable.Reference,
		From:             new(from),
		To:               new(to),
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
	store := postgres.NewWithStatementMargin(fixture.tx, 0)

	res, err := store.GetStatement(t.Context(), statement.ListInput{
		AccountReference: fixture.payable.Reference,
		From:             new(time.Date(2025, time.January, 1, 0, 0, 0, 0, time.UTC)),
		To:               new(time.Date(2025, time.February, 1, 0, 0, 0, 0, time.UTC)),
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
	store := postgres.NewWithStatementMargin(fixture.tx, 0)

	from := time.Date(2026, time.September, 1, 0, 0, 0, 0, time.UTC)
	to := time.Date(2026, time.October, 1, 0, 0, 0, 0, time.UTC)

	t.Run("account not found", func(t *testing.T) {
		_, err := store.GetStatement(t.Context(), statement.ListInput{
			AccountReference: "acct_01K00000000000000000000000",
			From:             new(from),
			To:               new(to),
			Limit:            50,
		})
		if !errors.Is(err, account.ErrAccountNotFound) {
			t.Errorf("GetStatement() error = %v, want ErrAccountNotFound", err)
		}
	})

	t.Run("internal account returns account not found", func(t *testing.T) {
		_, err := store.GetStatement(t.Context(), statement.ListInput{
			AccountReference: fixture.platform.Cash.Reference,
			From:             new(from),
			To:               new(to),
			Limit:            50,
		})
		if !errors.Is(err, account.ErrAccountNotFound) {
			t.Errorf("GetStatement() error = %v, want ErrAccountNotFound", err)
		}
	})

	t.Run("cancelled context returns context error", func(t *testing.T) {
		ctx, cancel := context.WithCancel(t.Context())
		cancel()

		_, err := store.GetStatement(ctx, statement.ListInput{
			AccountReference: fixture.payable.Reference,
			From:             new(from),
			To:               new(to),
			Limit:            50,
		})
		if !errors.Is(err, context.Canceled) {
			t.Errorf("GetStatement() error = %v, want context.Canceled", err)
		}
		if errors.Is(err, account.ErrAccountNotFound) {
			t.Errorf("GetStatement() incorrectly masked error as ErrAccountNotFound")
		}
	})
}

// TestStore_GetStatement_ReconciliationIdentity verifies the two reconciliation identities:
// 1. For the first movement in a period: opening_balance + signed(amount) = balance_after.
// 2. closing_balance - opening_balance equals the signed sum of the period's movements.
func TestStore_GetStatement_ReconciliationIdentity(t *testing.T) {
	fixture := newPostEntryFixture(t)
	store := postgres.NewWithStatementMargin(fixture.tx, 0)

	// Entry 0: before period (creates opening balance of 20,000)
	eff0 := time.Date(2026, time.September, 1, 10, 0, 0, 0, time.UTC)
	fixture.mustPost(t, journal.PostInput{
		LedgerSlug:  "ngn_ng",
		RequestID:   "req_recon_id_0",
		Kind:        "payment",
		Description: "Opening credit",
		EffectiveAt: &eff0,
		Lines: []journal.LineInput{
			{
				DebitAccountReference:  fixture.platform.Cash.Reference,
				CreditAccountReference: fixture.payable.Reference,
				Amount:                 20_000,
				Purpose:                "Initial deposit",
			},
		},
	})

	var rec0 time.Time
	if err := fixture.tx.QueryRowContext(t.Context(),
		`SELECT recorded_at FROM account_movements WHERE account_id = $1 AND sequence = 1`,
		fixture.payable.ID,
	).Scan(&rec0); err != nil {
		t.Fatalf("query rec0: %v", err)
	}

	periodFrom := rec0.Add(1 * time.Millisecond)

	// Entry 1: inside period (credit 10,000, debit 500 fee)
	eff1 := time.Date(2026, time.September, 5, 10, 0, 0, 0, time.UTC)
	fixture.mustPost(t, journal.PostInput{
		LedgerSlug:  "ngn_ng",
		RequestID:   "req_recon_id_1",
		Kind:        "payment",
		Description: "Period payment 1",
		EffectiveAt: &eff1,
		Lines: []journal.LineInput{
			{
				DebitAccountReference:  fixture.platform.Cash.Reference,
				CreditAccountReference: fixture.payable.Reference,
				Amount:                 10_000,
				Purpose:                "Payment 1",
			},
			{
				DebitAccountReference:  fixture.payable.Reference,
				CreditAccountReference: fixture.platform.FeeRevenue.Reference,
				Amount:                 500,
				Purpose:                "Fee 1",
			},
		},
	})

	// Entry 2: inside period (debit 5,000 withdrawal)
	eff2 := time.Date(2026, time.September, 10, 10, 0, 0, 0, time.UTC)
	fixture.mustPost(t, journal.PostInput{
		LedgerSlug:  "ngn_ng",
		RequestID:   "req_recon_id_2",
		Kind:        "payment",
		Description: "Period withdrawal 2",
		EffectiveAt: &eff2,
		Lines: []journal.LineInput{
			{
				DebitAccountReference:  fixture.payable.Reference,
				CreditAccountReference: fixture.platform.Cash.Reference,
				Amount:                 5_000,
				Purpose:                "Withdrawal 2",
			},
		},
	})

	periodTo := time.Now().UTC().Add(24 * time.Hour)

	res, err := store.GetStatement(t.Context(), statement.ListInput{
		AccountReference: fixture.payable.Reference,
		From:             new(periodFrom),
		To:               new(periodTo),
		Limit:            50,
	})
	if err != nil {
		t.Fatalf("GetStatement error: %v", err)
	}

	if res.OpeningBalance != 20_000 {
		t.Errorf("OpeningBalance = %d, want 20000", res.OpeningBalance)
	}

	if len(res.Movements) != 3 {
		t.Fatalf("len(Movements) = %d, want 3", len(res.Movements))
	}

	// 1. For the first movement in a period: opening_balance + signed(amount) = balance_after
	firstM := res.Movements[0]
	var firstSigned int64
	if firstM.Direction == statement.DirectionCredit {
		firstSigned = firstM.Amount
	} else {
		firstSigned = -firstM.Amount
	}
	if res.OpeningBalance+firstSigned != firstM.BalanceAfter {
		t.Errorf("opening_balance (%d) + signed(amount) (%d) = %d != balance_after (%d)",
			res.OpeningBalance, firstSigned, res.OpeningBalance+firstSigned, firstM.BalanceAfter)
	}

	// 2. closing_balance - opening_balance equals the signed sum of the period's movements
	var sumSigned int64
	for _, m := range res.Movements {
		if m.Direction == statement.DirectionCredit {
			sumSigned += m.Amount
		} else {
			sumSigned -= m.Amount
		}
	}
	balanceDiff := res.ClosingBalance - res.OpeningBalance
	if balanceDiff != sumSigned {
		t.Errorf("closing_balance (%d) - opening_balance (%d) = %d != sum(signed_amounts) (%d)",
			res.ClosingBalance, res.OpeningBalance, balanceDiff, sumSigned)
	}
}

func TestStore_GetStatement_Period(t *testing.T) {
	fixture := newPostEntryFixture(t)
	store := postgres.New(fixture.tx)

	clock := func() time.Time {
		t.Helper()
		var now time.Time
		if err := fixture.tx.QueryRowContext(t.Context(), `SELECT clock_timestamp()`).Scan(&now); err != nil {
			t.Fatalf("read database clock: %v", err)
		}
		return now
	}

	fixture.mustPost(t, journal.PostInput{
		LedgerSlug:  "ngn_ng",
		RequestID:   "req_period_recent",
		Kind:        "payment",
		Description: "Posting inside the margin",
		Lines: []journal.LineInput{{
			DebitAccountReference:  fixture.platform.Cash.Reference,
			CreditAccountReference: fixture.payable.Reference,
			Amount:                 1_000,
			Purpose:                "Card payment",
		}},
	})

	t.Run("omitted to ends the margin before the database clock", func(t *testing.T) {
		before := clock()
		res, err := store.GetStatement(t.Context(), statement.ListInput{
			AccountReference: fixture.payable.Reference,
			Limit:            10,
		})
		after := clock()
		if err != nil {
			t.Fatalf("GetStatement() error = %v", err)
		}

		assertBetween(t, "Period.To", res.Period.To, before.Add(-statement.Margin), after.Add(-statement.Margin))
		if want := res.Period.To.Add(-statement.DefaultPeriod); !res.Period.From.Equal(want) {
			t.Errorf("Period.From = %v, want %v", res.Period.From, want)
		}
		if len(res.Movements) != 0 || res.ClosingBalance != 0 {
			t.Errorf("statement includes the posting inside the margin: movements %d, closing %d",
				len(res.Movements), res.ClosingBalance)
		}
	})

	t.Run("later to is reduced", func(t *testing.T) {
		before := clock()
		res, err := store.GetStatement(t.Context(), statement.ListInput{
			AccountReference: fixture.payable.Reference,
			From:             new(before.Add(-time.Hour)),
			To:               new(before.Add(time.Hour)),
			Limit:            10,
		})
		after := clock()
		if err != nil {
			t.Fatalf("GetStatement() error = %v", err)
		}

		assertBetween(t, "Period.To", res.Period.To, before.Add(-statement.Margin), after.Add(-statement.Margin))
	})

	t.Run("earlier to is kept", func(t *testing.T) {
		to := clock().Add(-time.Hour).Truncate(time.Microsecond)
		from := to.Add(-time.Hour)
		res, err := store.GetStatement(t.Context(), statement.ListInput{
			AccountReference: fixture.payable.Reference,
			From:             &from,
			To:               &to,
			Limit:            10,
		})
		if err != nil {
			t.Fatalf("GetStatement() error = %v", err)
		}

		if !res.Period.From.Equal(from) || !res.Period.To.Equal(to) {
			t.Errorf("Period = (%v, %v), want (%v, %v)", res.Period.From, res.Period.To, from, to)
		}
	})

	errorTests := []struct {
		name    string
		account string
		from    func(now time.Time) time.Time
		to      func(now time.Time) time.Time
		wantErr error
	}{
		{
			name:    "from not before the reduced to",
			account: fixture.payable.Reference,
			from:    func(now time.Time) time.Time { return now.Add(-statement.Margin / 2) },
			to:      func(now time.Time) time.Time { return now.Add(time.Hour) },
			wantErr: statement.ErrPeriodNotOrdered,
		},
		{
			name:    "period longer than the maximum",
			account: fixture.payable.Reference,
			from:    func(now time.Time) time.Time { return now.Add(-statement.MaxPeriod - 2*time.Hour) },
			to:      func(now time.Time) time.Time { return now.Add(-time.Hour) },
			wantErr: statement.ErrPeriodTooLong,
		},
		{
			name:    "missing account precedes a period error",
			account: "acct_01M20H8704F1FDM1CFWSZDVJPV",
			from:    func(now time.Time) time.Time { return now.Add(-statement.Margin / 2) },
			to:      func(now time.Time) time.Time { return now.Add(time.Hour) },
			wantErr: account.ErrAccountNotFound,
		},
	}

	for _, tt := range errorTests {
		t.Run(tt.name, func(t *testing.T) {
			now := clock()
			_, err := store.GetStatement(t.Context(), statement.ListInput{
				AccountReference: tt.account,
				From:             new(tt.from(now)),
				To:               new(tt.to(now)),
				Limit:            10,
			})
			if !errors.Is(err, tt.wantErr) {
				t.Errorf("GetStatement() error = %v, want %v", err, tt.wantErr)
			}
		})
	}
}

func assertBetween(t *testing.T, name string, got, earliest, latest time.Time) {
	t.Helper()
	if got.Before(earliest) || got.After(latest) {
		t.Errorf("%s = %v, want between %v and %v", name, got, earliest, latest)
	}
}
