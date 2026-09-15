//go:build integration

package postgres_test

import (
	"database/sql"
	"errors"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/oklog/ulid/v2"

	"yanmifeakeju.com/ledger/internal/account"
	"yanmifeakeju.com/ledger/internal/journal"
	"yanmifeakeju.com/ledger/internal/postgres"
)

// TestStore_PostEntry verifies that a posted payment persists its entry and
// line and atomically updates the cash and merchant payable counters.
func TestStore_PostEntry(t *testing.T) {
	fixture := newPostEntryFixture(t)

	description := "Record merchant payment"
	effectiveAt := time.Date(2026, time.August, 20, 10, 30, 0, 0, time.UTC)
	const amount int64 = 12_500

	result := fixture.mustPost(t, journal.PostInput{
		LedgerSlug:  "ngn_ng",
		RequestID:   "request_1",
		Kind:        journal.KindPayment,
		Description: &description,
		EffectiveAt: &effectiveAt,
		Lines: []journal.LineInput{
			{
				DebitAccountReference:  fixture.platform.Cash.Reference,
				CreditAccountReference: fixture.payable.Reference,
				Amount:                 amount,
			},
		},
	})

	if !result.Created {
		t.Error("PostEntry() Created = false, want true")
	}

	assertPostedEntry(t, result.Entry, postedEntryExpectation{
		LedgerID:    fixture.ledgerID,
		RequestID:   "request_1",
		Kind:        journal.KindPayment,
		Description: &description,
		EffectiveAt: effectiveAt,
	})
	assertJournalLines(t, fixture.tx, result.Entry.ID, []journal.Line{
		{
			EntryID:         result.Entry.ID,
			LedgerID:        fixture.ledgerID,
			Amount:          amount,
			DebitAccountID:  fixture.platform.Cash.ID,
			CreditAccountID: fixture.payable.ID,
			LineNumber:      1,
			Effect:          journal.EffectPosted,
		},
	})

	debitBalances := readAccountBalances(t, fixture.tx, fixture.platform.Cash.ID)
	if debitBalances != (accountBalances{DebitsPosted: amount}) {
		t.Errorf("cash balances = %+v, want DebitsPosted=%d", debitBalances, amount)
	}
	creditBalances := readAccountBalances(t, fixture.tx, fixture.payable.ID)
	if creditBalances != (accountBalances{CreditsPosted: amount}) {
		t.Errorf("payable balances = %+v, want CreditsPosted=%d", creditBalances, amount)
	}
}

// TestStore_PostEntry_MultipleLines verifies that a payment and its fee retain
// input order and aggregate correctly when the payable appears on both sides.
func TestStore_PostEntry_MultipleLines(t *testing.T) {
	fixture := newPostEntryFixture(t)

	description := "Payment received"
	effectiveAt := time.Date(2026, time.August, 20, 10, 30, 0, 0, time.UTC)

	result := fixture.mustPost(t, journal.PostInput{
		LedgerSlug:  "ngn_ng",
		RequestID:   "request_1",
		Kind:        journal.KindPayment,
		Description: &description,
		EffectiveAt: &effectiveAt,
		Lines: []journal.LineInput{
			{
				DebitAccountReference:  fixture.platform.Cash.Reference,
				CreditAccountReference: fixture.payable.Reference,
				Amount:                 10_000,
			},
			{
				DebitAccountReference:  fixture.payable.Reference,
				CreditAccountReference: fixture.platform.FeeRevenue.Reference,
				Amount:                 200,
			},
		},
	})

	if !result.Created {
		t.Error("PostEntry() Created = false, want true")
	}

	wantLines := []journal.Line{
		{
			EntryID:         result.Entry.ID,
			LedgerID:        fixture.ledgerID,
			DebitAccountID:  fixture.platform.Cash.ID,
			CreditAccountID: fixture.payable.ID,
			Amount:          10_000,
			LineNumber:      1,
			Effect:          journal.EffectPosted,
		},
		{
			EntryID:         result.Entry.ID,
			LedgerID:        fixture.ledgerID,
			DebitAccountID:  fixture.payable.ID,
			CreditAccountID: fixture.platform.FeeRevenue.ID,
			Amount:          200,
			LineNumber:      2,
			Effect:          journal.EffectPosted,
		},
	}
	assertJournalLines(t, fixture.tx, result.Entry.ID, wantLines)

	if got := readAccountBalances(t, fixture.tx, fixture.platform.Cash.ID); got != (accountBalances{DebitsPosted: 10_000}) {
		t.Errorf("cash balances = %+v, want DebitsPosted=10000", got)
	}
	if got := readAccountBalances(t, fixture.tx, fixture.payable.ID); got != (accountBalances{DebitsPosted: 200, CreditsPosted: 10_000}) {
		t.Errorf("payable balances = %+v, want DebitsPosted=200 CreditsPosted=10000", got)
	}
	if got := readAccountBalances(t, fixture.tx, fixture.platform.FeeRevenue.ID); got != (accountBalances{CreditsPosted: 200}) {
		t.Errorf("fee revenue balances = %+v, want CreditsPosted=200", got)
	}
}

// TestStore_PostEntry_DefaultsEffectiveAt verifies that a database-generated
// effective time remains stable when an otherwise identical request is retried.
func TestStore_PostEntry_DefaultsEffectiveAt(t *testing.T) {
	fixture := newPostEntryFixture(t)

	description := "Payment received"

	posted1 := fixture.mustPost(t, journal.PostInput{
		LedgerSlug:  "ngn_ng",
		RequestID:   "request_1",
		Kind:        journal.KindPayment,
		Description: &description,
		Lines: []journal.LineInput{
			{
				DebitAccountReference:  fixture.platform.Cash.Reference,
				CreditAccountReference: fixture.payable.Reference,
				Amount:                 10_000,
			},
			{
				DebitAccountReference:  fixture.payable.Reference,
				CreditAccountReference: fixture.platform.FeeRevenue.Reference,
				Amount:                 200,
			},
		},
	})

	if !posted1.Created {
		t.Error("PostEntry() Created = false, want true")
	}

	posted2 := fixture.mustPost(t, journal.PostInput{
		LedgerSlug:  "ngn_ng",
		RequestID:   "request_1",
		Kind:        journal.KindPayment,
		Description: &description,
		Lines: []journal.LineInput{
			{
				DebitAccountReference:  fixture.platform.Cash.Reference,
				CreditAccountReference: fixture.payable.Reference,
				Amount:                 10_000,
			},
			{
				DebitAccountReference:  fixture.payable.Reference,
				CreditAccountReference: fixture.platform.FeeRevenue.Reference,
				Amount:                 200,
			},
		},
	})

	if posted2.Created {
		t.Error("PostEntry() Created = true, want false")
	}

	if !posted1.Entry.EffectiveAt.Equal(posted2.Entry.EffectiveAt) {
		t.Error("PostEntry() Created = true, want false")
	}

	wantLines := []journal.Line{
		{
			EntryID:         posted1.Entry.ID,
			LedgerID:        fixture.ledgerID,
			DebitAccountID:  fixture.platform.Cash.ID,
			CreditAccountID: fixture.payable.ID,
			Amount:          10_000,
			LineNumber:      1,
			Effect:          journal.EffectPosted,
		},
		{
			EntryID:         posted1.Entry.ID,
			LedgerID:        fixture.ledgerID,
			DebitAccountID:  fixture.payable.ID,
			CreditAccountID: fixture.platform.FeeRevenue.ID,
			Amount:          200,
			LineNumber:      2,
			Effect:          journal.EffectPosted,
		},
	}
	assertJournalLines(t, fixture.tx, posted1.Entry.ID, wantLines)

	if got := readAccountBalances(t, fixture.tx, fixture.platform.Cash.ID); got != (accountBalances{DebitsPosted: 10_000}) {
		t.Errorf("cash balances = %+v, want DebitsPosted=10000", got)
	}

	if got := readAccountBalances(t, fixture.tx, fixture.payable.ID); got != (accountBalances{DebitsPosted: 200, CreditsPosted: 10_000}) {
		t.Errorf("payable balances = %+v, want DebitsPosted=200 CreditsPosted=10000", got)
	}
	if got := readAccountBalances(t, fixture.tx, fixture.platform.FeeRevenue.ID); got != (accountBalances{CreditsPosted: 200}) {
		t.Errorf("fee revenue balances = %+v, want CreditsPosted=200", got)
	}
}

// TestStore_PostEntry_IdempotentRetry verifies that retrying identical input
// returns the original entry without duplicating lines or balance movements.
func TestStore_PostEntry_IdempotentRetry(t *testing.T) {
	fixture := newPostEntryFixture(t)

	description := "Payment received idempotent"

	posted1 := fixture.mustPost(t, journal.PostInput{
		LedgerSlug:  "ngn_ng",
		RequestID:   "request_1",
		Kind:        journal.KindPayment,
		Description: &description,
		Lines: []journal.LineInput{
			{
				DebitAccountReference:  fixture.platform.Cash.Reference,
				CreditAccountReference: fixture.payable.Reference,
				Amount:                 50_000,
			},
			{
				DebitAccountReference:  fixture.payable.Reference,
				CreditAccountReference: fixture.platform.FeeRevenue.Reference,
				Amount:                 500,
			},
		},
	})

	if !posted1.Created {
		t.Errorf("PostEntry() created = false, want true")
	}

	posted2 := fixture.mustPost(t, journal.PostInput{
		LedgerSlug:  "ngn_ng",
		RequestID:   "request_1",
		Kind:        journal.KindPayment,
		Description: &description,
		Lines: []journal.LineInput{
			{
				DebitAccountReference:  fixture.platform.Cash.Reference,
				CreditAccountReference: fixture.payable.Reference,
				Amount:                 50_000,
			},
			{
				DebitAccountReference:  fixture.payable.Reference,
				CreditAccountReference: fixture.platform.FeeRevenue.Reference,
				Amount:                 500,
			},
		},
	})

	if posted2.Created {
		t.Errorf("PostEntry() created = true, want false")
	}

	if !reflect.DeepEqual(posted1.Entry, posted2.Entry) {
		t.Errorf("want posted1 == posted2, got posted1 =  %#v, posted2 %#v", posted1.Entry, posted2.Entry)
	}

	wantLines := []journal.Line{
		{
			EntryID:         posted1.Entry.ID,
			LedgerID:        fixture.ledgerID,
			DebitAccountID:  fixture.platform.Cash.ID,
			CreditAccountID: fixture.payable.ID,
			Amount:          50_000,
			LineNumber:      1,
			Effect:          journal.EffectPosted,
		},
		{
			EntryID:         posted1.Entry.ID,
			LedgerID:        fixture.ledgerID,
			DebitAccountID:  fixture.payable.ID,
			CreditAccountID: fixture.platform.FeeRevenue.ID,
			Amount:          500,
			LineNumber:      2,
			Effect:          journal.EffectPosted,
		},
	}
	assertJournalLines(t, fixture.tx, posted1.Entry.ID, wantLines)

	if got := readAccountBalances(t, fixture.tx, fixture.platform.Cash.ID); got != (accountBalances{DebitsPosted: 50_000}) {
		t.Errorf("cash balances = %+v, want DebitsPosted=50000", got)
	}

	if got := readAccountBalances(t, fixture.tx, fixture.payable.ID); got != (accountBalances{DebitsPosted: 500, CreditsPosted: 50_000}) {
		t.Errorf("payable balances = %+v, want DebitsPosted=500 CreditsPosted=50000", got)
	}
}

// TestStore_PostEntry_IdempotencyAcrossLedgers verifies that posting with the same
// Idempotency-Key (request ID) to two different ledgers creates two entries, and
// repeating it within one ledger returns the original entry.
func TestStore_PostEntry_IdempotencyAcrossLedgers(t *testing.T) {
	fixture := newPostEntryFixture(t)
	desc := "Payment across ledgers"
	reqID := "shared_idempotency_key"

	ngnInput := journal.PostInput{
		LedgerSlug:  "ngn_ng",
		RequestID:   reqID,
		Kind:        journal.KindPayment,
		Description: &desc,
		Lines: []journal.LineInput{
			{
				DebitAccountReference:  fixture.platform.Cash.Reference,
				CreditAccountReference: fixture.payable.Reference,
				Amount:                 10_000,
			},
		},
	}
	ngnPosted1 := fixture.mustPost(t, ngnInput)
	if !ngnPosted1.Created {
		t.Fatal("first NGN PostEntry() Created = false, want true")
	}

	otherLedgerID := seedLedger(t, fixture.tx, "usd_ng", "USD")
	otherCash := seedPlatformAccount(t, fixture.tx, otherLedgerID, account.KindCash)
	otherPayableResult, err := fixture.store.CreatePayableAccount(t.Context(), account.CreatePayableInput{
		LedgerSlug: "usd_ng",
		ExternalID: "merchant_usd",
		Name:       "USD Merchant",
	})
	if err != nil {
		t.Fatalf("create USD payable account: %v", err)
	}

	usdInput := journal.PostInput{
		LedgerSlug:  "usd_ng",
		RequestID:   reqID,
		Kind:        journal.KindPayment,
		Description: &desc,
		Lines: []journal.LineInput{
			{
				DebitAccountReference:  otherCash.Reference,
				CreditAccountReference: otherPayableResult.Account.Reference,
				Amount:                 20_000,
			},
		},
	}
	usdPosted1 := fixture.mustPost(t, usdInput)
	if !usdPosted1.Created {
		t.Fatal("first USD PostEntry() Created = false, want true")
	}

	if ngnPosted1.Entry.ID == usdPosted1.Entry.ID {
		t.Errorf("entries in different ledgers share the same ID: %d", ngnPosted1.Entry.ID)
	}
	if ngnPosted1.Entry.LedgerID == usdPosted1.Entry.LedgerID {
		t.Errorf("entries have the same LedgerID: %d", ngnPosted1.Entry.LedgerID)
	}

	ngnPosted2 := fixture.mustPost(t, ngnInput)
	if ngnPosted2.Created {
		t.Error("repeated NGN PostEntry() Created = true, want false")
	}
	if ngnPosted2.Entry.ID != ngnPosted1.Entry.ID {
		t.Errorf("repeated NGN entry ID = %d, want %d", ngnPosted2.Entry.ID, ngnPosted1.Entry.ID)
	}

	usdPosted2 := fixture.mustPost(t, usdInput)
	if usdPosted2.Created {
		t.Error("repeated USD PostEntry() Created = true, want false")
	}
	if usdPosted2.Entry.ID != usdPosted1.Entry.ID {
		t.Errorf("repeated USD entry ID = %d, want %d", usdPosted2.Entry.ID, usdPosted1.Entry.ID)
	}
}

// TestStore_PostEntry_IdempotencyConflict verifies that reusing a request ID
// with different content is rejected without changing the original posting.
func TestStore_PostEntry_IdempotencyConflict(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*testing.T, postEntryFixture, *journal.PostInput)
	}{
		{
			name: "amount",
			mutate: func(_ *testing.T, _ postEntryFixture, input *journal.PostInput) {
				lines := slices.Clone(input.Lines)
				for i := range lines {
					lines[i].Amount += 500
				}
				input.Lines = lines
			},
		},
		{
			name: "description",
			mutate: func(_ *testing.T, _ postEntryFixture, input *journal.PostInput) {
				desc := *input.Description
				desc += desc
				input.Description = &desc
			},
		},
		{
			name: "effective_time",
			mutate: func(_ *testing.T, _ postEntryFixture, input *journal.PostInput) {
				eff := *input.EffectiveAt
				eff = eff.Add(-2 * time.Hour)
				input.EffectiveAt = &eff
			},
		},
		{
			name: "kind",
			mutate: func(_ *testing.T, _ postEntryFixture, input *journal.PostInput) {
				input.Kind = journal.KindTransfer
			},
		},
		{
			name: "line_order",
			mutate: func(_ *testing.T, _ postEntryFixture, input *journal.PostInput) {
				lines := slices.Clone(input.Lines)
				slices.Reverse(lines)
				input.Lines = lines
			},
		},
		{
			name: "account_reference",
			mutate: func(t *testing.T, fixture postEntryFixture, input *journal.PostInput) {
				payableAccount, err := fixture.store.CreatePayableAccount(t.Context(), account.CreatePayableInput{
					LedgerSlug: fixture.slug,
					ExternalID: "acc_merchant_1",
					Name:       "Acme Ltd",
				})
				if err != nil {
					t.Fatalf("create alternate payable account: %v", err)
				}

				lines := slices.Clone(input.Lines)
				lines[0].CreditAccountReference = payableAccount.Account.Reference
				input.Lines = lines
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fixture := newPostEntryFixture(t)
			description := "Payment received idempotent"
			effectiveAt := time.Date(2026, time.August, 20, 10, 30, 0, 0, time.UTC)
			input := journal.PostInput{
				LedgerSlug:  "ngn_ng",
				RequestID:   "request_1",
				Kind:        journal.KindPayment,
				EffectiveAt: &effectiveAt,
				Description: &description,
				Lines: []journal.LineInput{
					{
						DebitAccountReference:  fixture.platform.Cash.Reference,
						CreditAccountReference: fixture.payable.Reference,
						Amount:                 50_000,
					},
					{
						DebitAccountReference:  fixture.payable.Reference,
						CreditAccountReference: fixture.platform.FeeRevenue.Reference,
						Amount:                 500,
					},
				},
			}

			posted := fixture.mustPost(t, input)

			if !posted.Created {
				t.Errorf("PostEntry() created = false, want true")
			}

			conflictingInput := input
			tt.mutate(t, fixture, &conflictingInput)

			postErr := runWithRollbackSavepoint(t, fixture.tx, func() error {
				_, err := fixture.store.PostEntry(t.Context(), conflictingInput)
				return err
			})

			if postErr == nil {
				t.Fatalf("PostEntry() error = nil, want %v",
					journal.ErrIdempotencyConflict)
			}
			if !errors.Is(postErr, journal.ErrIdempotencyConflict) {
				t.Fatalf("want err = %#v, got %#v", journal.ErrIdempotencyConflict, postErr)
			}

			posted2 := fixture.mustPost(t, input)
			if posted2.Created {
				t.Error("PostEntry() Created = true, want false")
			}

			if !reflect.DeepEqual(posted.Entry, posted2.Entry) {
				t.Errorf("want posted == posted2, got posted =  %#v, posted2 %#v", posted.Entry, posted2.Entry)
			}

			wantLines := []journal.Line{
				{
					EntryID:         posted.Entry.ID,
					LedgerID:        fixture.ledgerID,
					DebitAccountID:  fixture.platform.Cash.ID,
					CreditAccountID: fixture.payable.ID,
					Amount:          50_000,
					LineNumber:      1,
					Effect:          journal.EffectPosted,
				},
				{
					EntryID:         posted.Entry.ID,
					LedgerID:        fixture.ledgerID,
					DebitAccountID:  fixture.payable.ID,
					CreditAccountID: fixture.platform.FeeRevenue.ID,
					Amount:          500,
					LineNumber:      2,
					Effect:          journal.EffectPosted,
				},
			}
			assertJournalLines(t, fixture.tx, posted.Entry.ID, wantLines)

			if got := readAccountBalances(t, fixture.tx, fixture.platform.Cash.ID); got != (accountBalances{DebitsPosted: 50_000}) {
				t.Errorf("cash balances = %+v, want DebitsPosted=50000", got)
			}

			if got := readAccountBalances(t, fixture.tx, fixture.payable.ID); got != (accountBalances{DebitsPosted: 500, CreditsPosted: 50_000}) {
				t.Errorf("payable balances = %+v, want DebitsPosted=500 CreditsPosted=50_000", got)
			}
			if got := readAccountBalances(t, fixture.tx, fixture.platform.FeeRevenue.ID); got != (accountBalances{CreditsPosted: 500}) {
				t.Errorf("fee revenue balances = %+v, want CreditsPosted=500", got)
			}
		})
	}
}

// TestStore_PostEntry_RetryAfterClosure verifies that an identical retry
// returns the original posting even when its ledger or an account later closes.
func TestStore_PostEntry_RetryAfterClosure(t *testing.T) {
	tests := []struct {
		name  string
		close func(*testing.T, postEntryFixture)
	}{
		{
			name: "ledger",
			close: func(t *testing.T, fixture postEntryFixture) {
				t.Helper()

				result, err := fixture.tx.ExecContext(
					t.Context(),
					`UPDATE ledgers SET is_closed = true WHERE id = $1`,
					fixture.ledgerID,
				)
				if err != nil {
					t.Fatalf("close ledger: %v", err)
				}
				if affected, err := result.RowsAffected(); err != nil {
					t.Fatalf("read closed ledger count: %v", err)
				} else if affected != 1 {
					t.Fatalf("closed ledger count = %d, want 1", affected)
				}
			},
		},
		{
			name: "participating account",
			close: func(t *testing.T, fixture postEntryFixture) {
				t.Helper()

				result, err := fixture.tx.ExecContext(
					t.Context(),
					`UPDATE accounts SET is_closed = true WHERE id = $1`,
					fixture.payable.ID,
				)
				if err != nil {
					t.Fatalf("close account: %v", err)
				}
				if affected, err := result.RowsAffected(); err != nil {
					t.Fatalf("read closed account count: %v", err)
				} else if affected != 1 {
					t.Fatalf("closed account count = %d, want 1", affected)
				}
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fixture := newPostEntryFixture(t)
			description := "Payment received"
			effectiveAt := time.Date(2026, time.August, 20, 10, 30, 0, 0, time.UTC)
			input := journal.PostInput{
				LedgerSlug:  fixture.slug,
				RequestID:   "request_1",
				Kind:        journal.KindPayment,
				EffectiveAt: &effectiveAt,
				Description: &description,
				Lines: []journal.LineInput{
					{
						DebitAccountReference:  fixture.platform.Cash.Reference,
						CreditAccountReference: fixture.payable.Reference,
						Amount:                 50_000,
					},
					{
						DebitAccountReference:  fixture.payable.Reference,
						CreditAccountReference: fixture.platform.FeeRevenue.Reference,
						Amount:                 500,
					},
				},
			}

			posted := fixture.mustPost(t, input)
			if !posted.Created {
				t.Fatal("first PostEntry() Created = false, want true")
			}

			tt.close(t, fixture)

			retried := fixture.mustPost(t, input)
			if retried.Created {
				t.Error("retry PostEntry() Created = true, want false")
			}
			if !reflect.DeepEqual(retried.Entry, posted.Entry) {
				t.Errorf("retry entry = %#v, want %#v", retried.Entry, posted.Entry)
			}

			assertJournalLines(t, fixture.tx, posted.Entry.ID, []journal.Line{
				{
					EntryID:         posted.Entry.ID,
					LedgerID:        fixture.ledgerID,
					DebitAccountID:  fixture.platform.Cash.ID,
					CreditAccountID: fixture.payable.ID,
					Amount:          50_000,
					LineNumber:      1,
					Effect:          journal.EffectPosted,
				},
				{
					EntryID:         posted.Entry.ID,
					LedgerID:        fixture.ledgerID,
					DebitAccountID:  fixture.payable.ID,
					CreditAccountID: fixture.platform.FeeRevenue.ID,
					Amount:          500,
					LineNumber:      2,
					Effect:          journal.EffectPosted,
				},
			})

			if got := readAccountBalances(t, fixture.tx, fixture.platform.Cash.ID); got != (accountBalances{DebitsPosted: 50_000}) {
				t.Errorf("cash balances = %+v, want DebitsPosted=50000", got)
			}
			if got := readAccountBalances(t, fixture.tx, fixture.payable.ID); got != (accountBalances{DebitsPosted: 500, CreditsPosted: 50_000}) {
				t.Errorf("payable balances = %+v, want DebitsPosted=500 CreditsPosted=50000", got)
			}
			if got := readAccountBalances(t, fixture.tx, fixture.platform.FeeRevenue.ID); got != (accountBalances{CreditsPosted: 500}) {
				t.Errorf("fee revenue balances = %+v, want CreditsPosted=500", got)
			}
		})
	}
}

// TestStore_PostEntry_Errors verifies that each posting SQLSTATE is translated
// to its corresponding domain error.
func TestStore_PostEntry_Errors(t *testing.T) {
	tests := []struct {
		name    string
		arrange func(*testing.T, postEntryFixture, *journal.PostInput)
		wantErr error
	}{
		{
			name: "ledger not found",
			arrange: func(_ *testing.T, _ postEntryFixture, input *journal.PostInput) {
				input.LedgerSlug = "missing"
			},
			wantErr: journal.ErrLedgerNotFound,
		},
		{
			name: "ledger closed",
			arrange: func(t *testing.T, fixture postEntryFixture, _ *journal.PostInput) {
				t.Helper()

				if _, err := fixture.tx.ExecContext(
					t.Context(),
					`UPDATE ledgers SET is_closed = true WHERE id = $1`,
					fixture.ledgerID,
				); err != nil {
					t.Fatalf("close ledger: %v", err)
				}
			},
			wantErr: journal.ErrLedgerClosed,
		},
		{
			name: "debit account not found",
			arrange: func(_ *testing.T, _ postEntryFixture, input *journal.PostInput) {
				input.Lines[0].DebitAccountReference = "acct_00000000000000000000000000"
			},
			wantErr: journal.ErrAccountNotFound,
		},
		{
			name: "credit account not found",
			arrange: func(_ *testing.T, _ postEntryFixture, input *journal.PostInput) {
				input.Lines[0].CreditAccountReference = "acct_00000000000000000000000000"
			},
			wantErr: journal.ErrAccountNotFound,
		},
		{
			name: "account belongs to another ledger",
			arrange: func(t *testing.T, fixture postEntryFixture, input *journal.PostInput) {
				t.Helper()

				otherLedgerID := seedLedger(t, fixture.tx, "usd_ng", "USD")
				otherCash := seedPlatformAccount(
					t,
					fixture.tx,
					otherLedgerID,
					account.KindCash,
				)
				input.Lines[0].DebitAccountReference = otherCash.Reference
			},
			wantErr: journal.ErrAccountNotFound,
		},
		{
			name: "debit account closed",
			arrange: func(t *testing.T, fixture postEntryFixture, _ *journal.PostInput) {
				t.Helper()

				if _, err := fixture.tx.ExecContext(
					t.Context(),
					`UPDATE accounts SET is_closed = true WHERE id = $1`,
					fixture.platform.Cash.ID,
				); err != nil {
					t.Fatalf("close debit account: %v", err)
				}
			},
			wantErr: journal.ErrAccountClosed,
		},
		{
			name: "credit account closed",
			arrange: func(t *testing.T, fixture postEntryFixture, _ *journal.PostInput) {
				t.Helper()

				if _, err := fixture.tx.ExecContext(
					t.Context(),
					`UPDATE accounts SET is_closed = true WHERE id = $1`,
					fixture.payable.ID,
				); err != nil {
					t.Fatalf("close credit account: %v", err)
				}
			},
			wantErr: journal.ErrAccountClosed,
		},
		{
			name: "debit restriction exceeded",
			arrange: func(_ *testing.T, fixture postEntryFixture, input *journal.PostInput) {
				input.Lines[0] = journal.LineInput{
					DebitAccountReference:  fixture.payable.Reference,
					CreditAccountReference: fixture.platform.FeeRevenue.Reference,
					Amount:                 100,
				}
			},
			wantErr: journal.ErrInsufficientFunds,
		},
		{
			name: "credit restriction exceeded",
			arrange: func(t *testing.T, fixture postEntryFixture, input *journal.PostInput) {
				t.Helper()

				if _, err := fixture.tx.ExecContext(
					t.Context(),
					`UPDATE accounts SET credits_must_not_exceed_debits = true WHERE id = $1`,
					fixture.platform.Cash.ID,
				); err != nil {
					t.Fatalf("restrict account credits: %v", err)
				}
				input.Lines[0] = journal.LineInput{
					DebitAccountReference:  fixture.platform.FeeRevenue.Reference,
					CreditAccountReference: fixture.platform.Cash.Reference,
					Amount:                 100,
				}
			},
			wantErr: journal.ErrInsufficientFunds,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fixture := newPostEntryFixture(t)
			input := journal.PostInput{
				LedgerSlug: fixture.slug,
				RequestID:  "request_1",
				Kind:       journal.KindPayment,
				Lines: []journal.LineInput{
					{
						DebitAccountReference:  fixture.platform.Cash.Reference,
						CreditAccountReference: fixture.payable.Reference,
						Amount:                 100,
					},
				},
			}
			tt.arrange(t, fixture, &input)

			_, err := fixture.store.PostEntry(t.Context(), input)
			if !errors.Is(err, tt.wantErr) {
				t.Errorf("PostEntry() error = %v, want %v", err, tt.wantErr)
			}
		})
	}
}

// TestStore_PostEntry_InvalidInputRollsBack verifies that invalid data cannot
// leave partial accounting records.
func TestStore_PostEntry_InvalidInputRollsBack(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*testing.T, postEntryFixture, *journal.PostInput)
		err    error
	}{
		{
			name: "no lines",
			mutate: func(_ *testing.T, _ postEntryFixture, pi *journal.PostInput) {
				pi.Lines = []journal.LineInput{}
			},
			err: journal.ErrNoLines,
		},
		{
			name: "self transfer",
			mutate: func(_ *testing.T, _ postEntryFixture, pi *journal.PostInput) {
				for i := range pi.Lines {
					line := pi.Lines[i]
					pi.Lines[i].DebitAccountReference = line.CreditAccountReference
				}
			},
			err: journal.ErrNoSelfTransfer,
		},
		{
			name: "zero amount",
			mutate: func(_ *testing.T, _ postEntryFixture, pi *journal.PostInput) {
				for i := range pi.Lines {
					pi.Lines[i].Amount = 0
				}
			},
			err: journal.ErrNonPositiveAmount,
		},
		{
			name: "negative amount",
			mutate: func(_ *testing.T, _ postEntryFixture, pi *journal.PostInput) {
				for i := range pi.Lines {
					pi.Lines[i].Amount = -1
				}
			},
			err: journal.ErrNonPositiveAmount,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fixture := newPostEntryFixture(t)
			description := "Payment received idempotent"
			effectiveAt := time.Date(2026, time.August, 20, 10, 30, 0, 0, time.UTC)
			input := journal.PostInput{
				LedgerSlug:  "ngn_ng",
				RequestID:   "request_1",
				Kind:        journal.KindPayment,
				EffectiveAt: &effectiveAt,
				Description: &description,
				Lines: []journal.LineInput{
					{
						DebitAccountReference:  fixture.platform.Cash.Reference,
						CreditAccountReference: fixture.payable.Reference,
						Amount:                 50_000,
					},
					{
						DebitAccountReference:  fixture.payable.Reference,
						CreditAccountReference: fixture.platform.FeeRevenue.Reference,
						Amount:                 500,
					},
				},
			}

			invalidInput := input
			tt.mutate(t, fixture, &invalidInput)

			accountIDs := []int64{
				fixture.platform.Cash.ID,
				fixture.platform.FeeRevenue.ID,
				fixture.payable.ID,
			}
			before := make(map[int64]accountBalances, len(accountIDs))
			for _, id := range accountIDs {
				before[id] = readAccountBalances(t, fixture.tx, id)
			}

			postErr := runWithRollbackSavepoint(t, fixture.tx, func() error {
				_, err := fixture.store.PostEntry(t.Context(), invalidInput)
				return err
			})
			if postErr == nil {
				t.Fatalf("PostEntry() err = nil; want %v", tt.err)
			}

			if !errors.Is(postErr, tt.err) {
				t.Fatalf("PostEntry err = %v; want %v", postErr, tt.err)
			}

			assertNoJournalEntry(t, fixture.tx, fixture.ledgerID, invalidInput.RequestID)
			assertNoJournalLines(t, fixture.tx, fixture.ledgerID)
			for _, id := range accountIDs {
				if got := readAccountBalances(t, fixture.tx, id); got != before[id] {
					t.Errorf("account %d balances = %+v, want %+v", id, got, before[id])
				}
			}
		})
	}
}

// TestStore_PostEntry_UnresolvedLineRollsBackEntireEntry verifies atomicity
// across a multi-line entry containing one unresolved account reference.
func TestStore_PostEntry_UnresolvedLineRollsBackEntireEntry(t *testing.T) {
	fixture := newPostEntryFixture(t)

	effectiveAt := time.Date(2026, time.August, 20, 10, 30, 0, 0, time.UTC)
	input := journal.PostInput{
		LedgerSlug:  "ngn_ng",
		RequestID:   "request_1",
		Kind:        journal.KindPayment,
		EffectiveAt: &effectiveAt,
		Lines: []journal.LineInput{
			{
				DebitAccountReference:  fixture.platform.Cash.Reference,
				CreditAccountReference: fixture.payable.Reference,
				Amount:                 50_000,
			},
			{
				DebitAccountReference:  "acc_invalid_account",
				CreditAccountReference: fixture.platform.FeeRevenue.Reference,
				Amount:                 500,
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
		before[id] = readAccountBalances(t, fixture.tx, id)
	}

	postErr := runWithRollbackSavepoint(t, fixture.tx, func() error {
		_, err := fixture.store.PostEntry(t.Context(), input)
		return err
	})
	if postErr == nil {
		t.Fatalf("PostEntry() err = nil; want %v", journal.ErrAccountNotFound)
	}

	if !errors.Is(postErr, journal.ErrAccountNotFound) {
		t.Fatalf("PostEntry err = %v; want %v", postErr, journal.ErrAccountNotFound)
	}

	assertNoJournalEntry(t, fixture.tx, fixture.ledgerID, input.RequestID)
	assertNoJournalLines(t, fixture.tx, fixture.ledgerID)
	for _, id := range accountIDs {
		if got := readAccountBalances(t, fixture.tx, id); got != before[id] {
			t.Errorf("account %d balances = %+v, want %+v", id, got, before[id])
		}
	}
}

type postEntryFixture struct {
	tx       *sql.Tx
	store    *postgres.Store
	ledgerID int
	slug     string
	payable  seededAccount
	platform platformAccounts
}

func newPostEntryFixture(t *testing.T) postEntryFixture {
	t.Helper()

	const slug = "ngn_ng"
	tx := newTestTx(t)
	ledgerID := seedLedger(t, tx, slug, "NGN")
	store := postgres.New(tx)

	result, err := store.CreatePayableAccount(t.Context(), account.CreatePayableInput{
		LedgerSlug: slug,
		ExternalID: "merchant_1",
		Name:       "Acme Ltd",
	})
	if err != nil {
		t.Fatalf("create payable account: %v", err)
	}

	return postEntryFixture{
		tx:       tx,
		ledgerID: ledgerID,
		store:    store,
		slug:     slug,
		payable:  lookupSeededAccount(t, tx, result.Account.Reference),
		platform: seedPlatformAccounts(t, tx, ledgerID),
	}
}

func (f postEntryFixture) mustPost(t *testing.T, input journal.PostInput) journal.PostResult {
	t.Helper()

	result, err := f.store.PostEntry(t.Context(), input)
	if err != nil {
		t.Fatalf("PostEntry() error = %v", err)
	}

	return result
}

type accountBalances struct {
	DebitsPending  int64
	CreditsPending int64
	DebitsPosted   int64
	CreditsPosted  int64
}

type seededAccount struct {
	ID        int64
	Reference string
}

func lookupSeededAccount(t *testing.T, tx *sql.Tx, reference string) seededAccount {
	t.Helper()

	var result seededAccount
	if err := tx.QueryRowContext(
		t.Context(),
		`SELECT id, public_ref FROM accounts WHERE public_ref = $1`,
		reference,
	).Scan(&result.ID, &result.Reference); err != nil {
		t.Fatalf("look up seeded account %q: %v", reference, err)
	}
	return result
}

// platformAccounts contains the platform-owned accounts for a ledger.
type platformAccounts struct {
	Cash       seededAccount
	FeeRevenue seededAccount
}

func seedPlatformAccounts(t *testing.T, tx *sql.Tx, ledgerID int) platformAccounts {
	t.Helper()

	return platformAccounts{
		Cash: seedPlatformAccount(t, tx, ledgerID, account.KindCash),
		FeeRevenue: seedPlatformAccount(
			t,
			tx,
			ledgerID,
			account.KindFeeRevenue,
		),
	}
}

func seedPlatformAccount(
	t *testing.T,
	tx *sql.Tx,
	ledgerID int,
	kind account.Kind,
) seededAccount {
	t.Helper()

	reference := "acct_" + ulid.Make().String()
	const query = `
		INSERT INTO accounts (public_ref, ledger_id, kind)
		VALUES ($1, $2, $3)
		RETURNING id`

	var id int64
	if err := tx.QueryRowContext(t.Context(), query, reference, ledgerID, kind).Scan(&id); err != nil {
		t.Fatalf("seed %q account: %v", kind, err)
	}

	return seededAccount{ID: id, Reference: reference}
}

func readAccountBalances(t *testing.T, db postgres.DBTX, accountID int64) accountBalances {
	t.Helper()

	const query = `
		SELECT debits_pending, credits_pending, debits_posted, credits_posted
		FROM accounts
		WHERE id = $1`

	var balances accountBalances
	if err := db.QueryRowContext(t.Context(), query, accountID).Scan(
		&balances.DebitsPending,
		&balances.CreditsPending,
		&balances.DebitsPosted,
		&balances.CreditsPosted,
	); err != nil {
		t.Fatalf("read account %d balances: %v", accountID, err)
	}

	return balances
}

type postedEntryExpectation struct {
	LedgerID    int
	RequestID   string
	Kind        journal.Kind
	Description *string
	EffectiveAt time.Time
}

func assertPostedEntry(t *testing.T, got journal.Entry, want postedEntryExpectation) {
	t.Helper()

	if got.ID == 0 {
		t.Error("entry ID = 0, want generated ID")
	}
	if !strings.HasPrefix(got.Reference, "jrn_") {
		t.Errorf("entry reference = %q, want jrn_ prefix", got.Reference)
	}
	if got.LedgerID != want.LedgerID {
		t.Errorf("entry LedgerID = %d, want %d", got.LedgerID, want.LedgerID)
	}
	if got.RequestID != want.RequestID {
		t.Errorf("entry RequestID = %q, want %q", got.RequestID, want.RequestID)
	}
	if got.Kind != want.Kind {
		t.Errorf("entry Kind = %q, want %q", got.Kind, want.Kind)
	}
	if got.State != journal.StatePosted {
		t.Errorf("entry State = %q, want %q", got.State, journal.StatePosted)
	}
	if want.Description == nil {
		if got.Description != nil {
			t.Errorf("entry Description = %q, want nil", *got.Description)
		}
	} else if got.Description == nil || *got.Description != *want.Description {
		t.Errorf("entry Description = %v, want %q", got.Description, *want.Description)
	}
	if got.ExpiresAt != nil {
		t.Errorf("entry ExpiresAt = %v, want nil", got.ExpiresAt)
	}
	if got.PendingEntryID != nil {
		t.Errorf("entry PendingEntryID = %v, want nil", got.PendingEntryID)
	}
	if !got.EffectiveAt.Equal(want.EffectiveAt) {
		t.Errorf("entry EffectiveAt = %v, want %v", got.EffectiveAt, want.EffectiveAt)
	}
	if got.CreatedAt.IsZero() {
		t.Error("entry CreatedAt is zero, want database timestamp")
	}
}

func assertNoJournalEntry(t *testing.T, tx *sql.Tx, ledgerID int, requestID string) {
	t.Helper()

	const query = `
		SELECT count(*)
		FROM journal_entries
		WHERE ledger_id = $1 AND request_id = $2`

	var count int
	if err := tx.QueryRowContext(t.Context(), query, ledgerID, requestID).Scan(&count); err != nil {
		t.Fatalf("count journal entries: %v", err)
	}
	if count != 0 {
		t.Errorf("journal entry count = %d, want 0", count)
	}
}

func assertNoJournalLines(t *testing.T, tx *sql.Tx, ledgerID int) {
	t.Helper()

	const query = `
		SELECT count(*)
		FROM journal_lines
		WHERE ledger_id = $1`

	var count int
	if err := tx.QueryRowContext(t.Context(), query, ledgerID).Scan(&count); err != nil {
		t.Fatalf("count journal lines: %v", err)
	}
	if count != 0 {
		t.Errorf("journal line count = %d, want 0", count)
	}
}

func assertJournalLines(t *testing.T, tx *sql.Tx, entryID int64, want []journal.Line) {
	t.Helper()

	const query = `
		SELECT journal_entry_id, ledger_id, amount, debit_account_id,
		       credit_account_id, line_number, effect
		FROM journal_lines
		WHERE journal_entry_id = $1
		ORDER BY line_number`

	rows, err := tx.QueryContext(t.Context(), query, entryID)
	if err != nil {
		t.Fatalf("query journal lines: %v", err)
	}
	defer rows.Close()

	var got []journal.Line
	for rows.Next() {
		var line journal.Line
		if err := rows.Scan(
			&line.EntryID,
			&line.LedgerID,
			&line.Amount,
			&line.DebitAccountID,
			&line.CreditAccountID,
			&line.LineNumber,
			&line.Effect,
		); err != nil {
			t.Fatalf("scan journal line: %v", err)
		}
		got = append(got, line)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate journal lines: %v", err)
	}
	if len(got) != len(want) {
		t.Fatalf("journal line count = %d, want %d", len(got), len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("journal line %d = %+v, want %+v", i, got[i], want[i])
		}
	}
}
