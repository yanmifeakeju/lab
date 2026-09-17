//go:build integration

package postgres_test

import (
	"database/sql"
	"errors"
	"fmt"
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
		},
	})

	if !result.Created {
		t.Error("PostEntry() Created = false, want true")
	}

	assertPostedEntry(t, fixture.tx, result.Entry, postedEntryExpectation{
		LedgerID:    fixture.ledgerID,
		RequestID:   "request_1",
		Kind:        "payment",
		Description: description,
		EffectiveAt: effectiveAt,
	})
	assertJournalLines(t, fixture.tx, result.Entry.Reference, []journalLineRow{
		{
			LedgerID:        fixture.ledgerID,
			Amount:          amount,
			DebitAccountID:  fixture.platform.Cash.ID,
			CreditAccountID: fixture.payable.ID,
			LineNumber:      1,
			Effect:          "posted",
			Purpose:         "Card payment",
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
		Kind:        "payment",
		Description: description,
		EffectiveAt: &effectiveAt,
		Lines: []journal.LineInput{
			{
				DebitAccountReference:  fixture.platform.Cash.Reference,
				CreditAccountReference: fixture.payable.Reference,
				Amount:                 10_000,
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

	if !result.Created {
		t.Error("PostEntry() Created = false, want true")
	}

	wantLines := []journalLineRow{
		{
			LedgerID:        fixture.ledgerID,
			DebitAccountID:  fixture.platform.Cash.ID,
			CreditAccountID: fixture.payable.ID,
			Amount:          10_000,
			LineNumber:      1,
			Effect:          "posted",
			Purpose:         "Card payment",
		},
		{
			LedgerID:        fixture.ledgerID,
			DebitAccountID:  fixture.payable.ID,
			CreditAccountID: fixture.platform.FeeRevenue.ID,
			Amount:          200,
			LineNumber:      2,
			Effect:          "posted",
			Purpose:         "Processing fee",
		},
	}
	assertJournalLines(t, fixture.tx, result.Entry.Reference, wantLines)

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
		Kind:        "payment",
		Description: description,
		Lines: []journal.LineInput{
			{
				DebitAccountReference:  fixture.platform.Cash.Reference,
				CreditAccountReference: fixture.payable.Reference,
				Amount:                 10_000,
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

	if !posted1.Created {
		t.Error("PostEntry() Created = false, want true")
	}

	posted2 := fixture.mustPost(t, journal.PostInput{
		LedgerSlug:  "ngn_ng",
		RequestID:   "request_1",
		Kind:        "payment",
		Description: description,
		Lines: []journal.LineInput{
			{
				DebitAccountReference:  fixture.platform.Cash.Reference,
				CreditAccountReference: fixture.payable.Reference,
				Amount:                 10_000,
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

	if posted2.Created {
		t.Error("PostEntry() Created = true, want false")
	}

	if !posted1.Entry.EffectiveAt.Equal(posted2.Entry.EffectiveAt) {
		t.Error("PostEntry() Created = true, want false")
	}

	wantLines := []journalLineRow{
		{
			LedgerID:        fixture.ledgerID,
			DebitAccountID:  fixture.platform.Cash.ID,
			CreditAccountID: fixture.payable.ID,
			Amount:          10_000,
			LineNumber:      1,
			Effect:          "posted",
			Purpose:         "Card payment",
		},
		{
			LedgerID:        fixture.ledgerID,
			DebitAccountID:  fixture.payable.ID,
			CreditAccountID: fixture.platform.FeeRevenue.ID,
			Amount:          200,
			LineNumber:      2,
			Effect:          "posted",
			Purpose:         "Processing fee",
		},
	}
	assertJournalLines(t, fixture.tx, posted1.Entry.Reference, wantLines)

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
		Kind:        "payment",
		Description: description,
		Lines: []journal.LineInput{
			{
				DebitAccountReference:  fixture.platform.Cash.Reference,
				CreditAccountReference: fixture.payable.Reference,
				Amount:                 50_000,
				Purpose:                "Card payment",
			},
			{
				DebitAccountReference:  fixture.payable.Reference,
				CreditAccountReference: fixture.platform.FeeRevenue.Reference,
				Amount:                 500,
				Purpose:                "Processing fee",
			},
		},
	})

	if !posted1.Created {
		t.Errorf("PostEntry() created = false, want true")
	}

	posted2 := fixture.mustPost(t, journal.PostInput{
		LedgerSlug:  "ngn_ng",
		RequestID:   "request_1",
		Kind:        "payment",
		Description: description,
		Lines: []journal.LineInput{
			{
				DebitAccountReference:  fixture.platform.Cash.Reference,
				CreditAccountReference: fixture.payable.Reference,
				Amount:                 50_000,
				Purpose:                "Card payment",
			},
			{
				DebitAccountReference:  fixture.payable.Reference,
				CreditAccountReference: fixture.platform.FeeRevenue.Reference,
				Amount:                 500,
				Purpose:                "Processing fee",
			},
		},
	})

	if posted2.Created {
		t.Errorf("PostEntry() created = true, want false")
	}

	if !reflect.DeepEqual(posted1.Entry, posted2.Entry) {
		t.Errorf("want posted1 == posted2, got posted1 =  %#v, posted2 %#v", posted1.Entry, posted2.Entry)
	}

	wantLines := []journalLineRow{
		{
			LedgerID:        fixture.ledgerID,
			DebitAccountID:  fixture.platform.Cash.ID,
			CreditAccountID: fixture.payable.ID,
			Amount:          50_000,
			LineNumber:      1,
			Effect:          "posted",
			Purpose:         "Card payment",
		},
		{
			LedgerID:        fixture.ledgerID,
			DebitAccountID:  fixture.payable.ID,
			CreditAccountID: fixture.platform.FeeRevenue.ID,
			Amount:          500,
			LineNumber:      2,
			Effect:          "posted",
			Purpose:         "Processing fee",
		},
	}
	assertJournalLines(t, fixture.tx, posted1.Entry.Reference, wantLines)

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
		Kind:        "payment",
		Description: desc,
		Lines: []journal.LineInput{
			{
				DebitAccountReference:  fixture.platform.Cash.Reference,
				CreditAccountReference: fixture.payable.Reference,
				Amount:                 10_000,
				Purpose:                "Card payment",
			},
		},
	}
	ngnPosted1 := fixture.mustPost(t, ngnInput)
	if !ngnPosted1.Created {
		t.Fatal("first NGN PostEntry() Created = false, want true")
	}

	otherLedgerID := seedLedger(t, fixture.tx, "usd_ng", "USD")
	otherCash := seedPlatformAccount(t, fixture.tx, otherLedgerID, "cash")
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
		Kind:        "payment",
		Description: desc,
		Lines: []journal.LineInput{
			{
				DebitAccountReference:  otherCash.Reference,
				CreditAccountReference: otherPayableResult.Account.Reference,
				Amount:                 20_000,
				Purpose:                "Card payment",
			},
		},
	}
	usdPosted1 := fixture.mustPost(t, usdInput)
	if !usdPosted1.Created {
		t.Fatal("first USD PostEntry() Created = false, want true")
	}

	if ngnPosted1.Entry.Reference == usdPosted1.Entry.Reference {
		t.Errorf("entries in different ledgers share the same reference: %s", ngnPosted1.Entry.Reference)
	}
	ngnLedgerID := readEntryLedgerID(t, fixture.tx, ngnPosted1.Entry.Reference)
	usdLedgerID := readEntryLedgerID(t, fixture.tx, usdPosted1.Entry.Reference)
	if ngnLedgerID == usdLedgerID {
		t.Errorf("entries have the same ledger ID: %d", ngnLedgerID)
	}

	ngnPosted2 := fixture.mustPost(t, ngnInput)
	if ngnPosted2.Created {
		t.Error("repeated NGN PostEntry() Created = true, want false")
	}
	if ngnPosted2.Entry.Reference != ngnPosted1.Entry.Reference {
		t.Errorf("repeated NGN entry reference = %s, want %s", ngnPosted2.Entry.Reference, ngnPosted1.Entry.Reference)
	}

	usdPosted2 := fixture.mustPost(t, usdInput)
	if usdPosted2.Created {
		t.Error("repeated USD PostEntry() Created = true, want false")
	}
	if usdPosted2.Entry.Reference != usdPosted1.Entry.Reference {
		t.Errorf("repeated USD entry reference = %s, want %s", usdPosted2.Entry.Reference, usdPosted1.Entry.Reference)
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
				input.Description += " changed"
			},
		},
		{
			name: "purpose",
			mutate: func(_ *testing.T, _ postEntryFixture, input *journal.PostInput) {
				lines := slices.Clone(input.Lines)
				lines[0].Purpose = "Different purpose"
				input.Lines = lines
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
				input.Kind = "transfer"
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
				Kind:        "payment",
				EffectiveAt: &effectiveAt,
				Description: description,
				Lines: []journal.LineInput{
					{
						DebitAccountReference:  fixture.platform.Cash.Reference,
						CreditAccountReference: fixture.payable.Reference,
						Amount:                 50_000,
						Purpose:                "Card payment",
					},
					{
						DebitAccountReference:  fixture.payable.Reference,
						CreditAccountReference: fixture.platform.FeeRevenue.Reference,
						Amount:                 500,
						Purpose:                "Processing fee",
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

			wantLines := []journalLineRow{
				{
					LedgerID:        fixture.ledgerID,
					DebitAccountID:  fixture.platform.Cash.ID,
					CreditAccountID: fixture.payable.ID,
					Amount:          50_000,
					LineNumber:      1,
					Effect:          "posted",
					Purpose:         "Card payment",
				},
				{
					LedgerID:        fixture.ledgerID,
					DebitAccountID:  fixture.payable.ID,
					CreditAccountID: fixture.platform.FeeRevenue.ID,
					Amount:          500,
					LineNumber:      2,
					Effect:          "posted",
					Purpose:         "Processing fee",
				},
			}
			assertJournalLines(t, fixture.tx, posted.Entry.Reference, wantLines)

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
					`UPDATE accounts SET closed_at = clock_timestamp() WHERE id = $1`,
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
				Kind:        "payment",
				EffectiveAt: &effectiveAt,
				Description: description,
				Lines: []journal.LineInput{
					{
						DebitAccountReference:  fixture.platform.Cash.Reference,
						CreditAccountReference: fixture.payable.Reference,
						Amount:                 50_000,
						Purpose:                "Card payment",
					},
					{
						DebitAccountReference:  fixture.payable.Reference,
						CreditAccountReference: fixture.platform.FeeRevenue.Reference,
						Amount:                 500,
						Purpose:                "Processing fee",
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

			assertJournalLines(t, fixture.tx, posted.Entry.Reference, []journalLineRow{
				{
					LedgerID:        fixture.ledgerID,
					DebitAccountID:  fixture.platform.Cash.ID,
					CreditAccountID: fixture.payable.ID,
					Amount:          50_000,
					LineNumber:      1,
					Effect:          "posted",
					Purpose:         "Card payment",
				},
				{
					LedgerID:        fixture.ledgerID,
					DebitAccountID:  fixture.payable.ID,
					CreditAccountID: fixture.platform.FeeRevenue.ID,
					Amount:          500,
					LineNumber:      2,
					Effect:          "posted",
					Purpose:         "Processing fee",
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
					"cash",
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
					`UPDATE accounts SET closed_at = clock_timestamp() WHERE id = $1`,
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
					`UPDATE accounts SET closed_at = clock_timestamp() WHERE id = $1`,
					fixture.payable.ID,
				); err != nil {
					t.Fatalf("close credit account: %v", err)
				}
			},
			wantErr: journal.ErrAccountClosed,
		},
		{
			name: "account with future closed_at succeeds",
			arrange: func(t *testing.T, fixture postEntryFixture, _ *journal.PostInput) {
				t.Helper()

				if _, err := fixture.tx.ExecContext(
					t.Context(),
					`UPDATE accounts SET closed_at = clock_timestamp() + interval '1 hour' WHERE id = $1`,
					fixture.payable.ID,
				); err != nil {
					t.Fatalf("set future closed_at: %v", err)
				}
			},
			wantErr: nil,
		},
		{
			name: "debit restriction exceeded",
			arrange: func(_ *testing.T, fixture postEntryFixture, input *journal.PostInput) {
				input.Lines[0] = journal.LineInput{
					DebitAccountReference:  fixture.payable.Reference,
					CreditAccountReference: fixture.platform.FeeRevenue.Reference,
					Amount:                 100,
					Purpose:                "Processing fee",
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
					Purpose:                "Platform fee",
				}
			},
			wantErr: journal.ErrInsufficientFunds,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fixture := newPostEntryFixture(t)
			input := journal.PostInput{
				LedgerSlug:  fixture.slug,
				RequestID:   "request_1",
				Kind:        "payment",
				Description: "Payment",
				Lines: []journal.LineInput{
					{
						DebitAccountReference:  fixture.platform.Cash.Reference,
						CreditAccountReference: fixture.payable.Reference,
						Amount:                 100,
						Purpose:                "Card payment",
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
			name: "account closed",
			mutate: func(t *testing.T, fixture postEntryFixture, _ *journal.PostInput) {
				t.Helper()
				if _, err := fixture.tx.ExecContext(
					t.Context(),
					`UPDATE accounts SET closed_at = clock_timestamp() WHERE id = $1`,
					fixture.payable.ID,
				); err != nil {
					t.Fatalf("close account: %v", err)
				}
			},
			err: journal.ErrAccountClosed,
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
				Kind:        "payment",
				EffectiveAt: &effectiveAt,
				Description: description,
				Lines: []journal.LineInput{
					{
						DebitAccountReference:  fixture.platform.Cash.Reference,
						CreditAccountReference: fixture.payable.Reference,
						Amount:                 50_000,
						Purpose:                "Card payment",
					},
					{
						DebitAccountReference:  fixture.payable.Reference,
						CreditAccountReference: fixture.platform.FeeRevenue.Reference,
						Amount:                 500,
						Purpose:                "Processing fee",
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
		Kind:        "payment",
		Description: "Payment received",
		EffectiveAt: &effectiveAt,
		Lines: []journal.LineInput{
			{
				DebitAccountReference:  fixture.platform.Cash.Reference,
				CreditAccountReference: fixture.payable.Reference,
				Amount:                 50_000,
				Purpose:                "Card payment",
			},
			{
				DebitAccountReference:  "acc_invalid_account",
				CreditAccountReference: fixture.platform.FeeRevenue.Reference,
				Amount:                 500,
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

// TestStore_PostEntry_ConstraintViolations verifies that invalid description,
// purpose, or kind values are rejected by database constraints and roll back atomically.
func TestStore_PostEntry_ConstraintViolations(t *testing.T) {
	tests := []struct {
		name    string
		mutate  func(*journal.PostInput)
		wantErr error
	}{
		{
			name: "empty description",
			mutate: func(pi *journal.PostInput) {
				pi.Description = ""
			},
			wantErr: journal.ErrBlankDescription,
		},
		{
			name: "blank description",
			mutate: func(pi *journal.PostInput) {
				pi.Description = "   "
			},
			wantErr: journal.ErrBlankDescription,
		},
		{
			name: "overlong description",
			mutate: func(pi *journal.PostInput) {
				pi.Description = strings.Repeat("d", 501)
			},
			wantErr: journal.ErrDescriptionTooLong,
		},
		{
			name: "empty purpose",
			mutate: func(pi *journal.PostInput) {
				pi.Lines[0].Purpose = ""
			},
			wantErr: journal.ErrBlankPurpose,
		},
		{
			name: "blank purpose",
			mutate: func(pi *journal.PostInput) {
				pi.Lines[0].Purpose = "   "
			},
			wantErr: journal.ErrBlankPurpose,
		},
		{
			name: "overlong purpose",
			mutate: func(pi *journal.PostInput) {
				pi.Lines[0].Purpose = strings.Repeat("p", 101)
			},
			wantErr: journal.ErrPurposeTooLong,
		},
		{
			name: "empty kind",
			mutate: func(pi *journal.PostInput) {
				pi.Kind = ""
			},
			wantErr: journal.ErrBlankKind,
		},
		{
			name: "blank kind",
			mutate: func(pi *journal.PostInput) {
				pi.Kind = "   "
			},
			wantErr: journal.ErrBlankKind,
		},
		{
			name: "overlong kind",
			mutate: func(pi *journal.PostInput) {
				pi.Kind = strings.Repeat("k", 65)
			},
			wantErr: journal.ErrKindTooLong,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fixture := newPostEntryFixture(t)
			input := journal.PostInput{
				LedgerSlug:  fixture.slug,
				RequestID:   "req_constraint_" + tt.name,
				Kind:        "payment",
				Description: "Payment received",
				Lines: []journal.LineInput{
					{
						DebitAccountReference:  fixture.platform.Cash.Reference,
						CreditAccountReference: fixture.payable.Reference,
						Amount:                 10_000,
						Purpose:                "Card payment",
					},
				},
			}
			tt.mutate(&input)

			accountIDs := []int64{
				fixture.platform.Cash.ID,
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
			if !errors.Is(postErr, tt.wantErr) {
				t.Fatalf("PostEntry() err = %v, want %v", postErr, tt.wantErr)
			}

			assertNoJournalEntry(t, fixture.tx, fixture.ledgerID, input.RequestID)
			assertNoJournalLines(t, fixture.tx, fixture.ledgerID)
			for _, id := range accountIDs {
				if got := readAccountBalances(t, fixture.tx, id); got != before[id] {
					t.Errorf("account %d balances = %+v, want %+v", id, got, before[id])
				}
			}
		})
	}
}

// TestStore_PostEntry_ClientDefinedKind verifies that any valid non-blank kind
// within the length limit is accepted and persisted.
func TestStore_PostEntry_ClientDefinedKind(t *testing.T) {
	fixture := newPostEntryFixture(t)

	customKinds := []string{
		"invoice_settlement",
		"payroll_distribution",
		"tax_withholding",
		strings.Repeat("k", 64),
	}

	for i, kind := range customKinds {
		reqID := fmt.Sprintf("req_custom_%d", i)
		result := fixture.mustPost(t, journal.PostInput{
			LedgerSlug:  fixture.slug,
			RequestID:   reqID,
			Kind:        kind,
			Description: "Custom kind entry",
			Lines: []journal.LineInput{
				{
					DebitAccountReference:  fixture.platform.Cash.Reference,
					CreditAccountReference: fixture.payable.Reference,
					Amount:                 1_000,
					Purpose:                "Custom line purpose",
				},
			},
		})

		if !result.Created {
			t.Errorf("PostEntry() Created = false, want true for kind %q", kind)
		}
		if result.Entry.Kind != kind {
			t.Errorf("Entry.Kind = %q, want %q", result.Entry.Kind, kind)
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
		Cash:       seedPlatformAccount(t, tx, ledgerID, "cash"),
		FeeRevenue: seedPlatformAccount(t, tx, ledgerID, "fee_revenue"),
	}
}

func seedPlatformAccount(
	t *testing.T,
	tx *sql.Tx,
	ledgerID int,
	label string,
) seededAccount {
	t.Helper()

	reference := "acct_" + ulid.Make().String()
	const query = `
		INSERT INTO accounts (public_ref, ledger_id, kind, label)
		VALUES ($1, $2, 'platform', $3)
		RETURNING id`

	var id int64
	if err := tx.QueryRowContext(t.Context(), query, reference, ledgerID, label).Scan(&id); err != nil {
		t.Fatalf("seed platform account %q: %v", label, err)
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
	Kind        string
	Description string
	EffectiveAt time.Time
}

func assertPostedEntry(t *testing.T, tx *sql.Tx, got journal.Entry, want postedEntryExpectation) {
	t.Helper()

	if !strings.HasPrefix(got.Reference, "jrn_") {
		t.Errorf("entry reference = %q, want jrn_ prefix", got.Reference)
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
	if got.Description != want.Description {
		t.Errorf("entry Description = %q, want %q", got.Description, want.Description)
	}
	if got.ExpiresAt != nil {
		t.Errorf("entry ExpiresAt = %v, want nil", got.ExpiresAt)
	}
	if !got.EffectiveAt.Equal(want.EffectiveAt) {
		t.Errorf("entry EffectiveAt = %v, want %v", got.EffectiveAt, want.EffectiveAt)
	}
	if got.CreatedAt.IsZero() {
		t.Error("entry CreatedAt is zero, want database timestamp")
	}

	const query = `
		SELECT ledger_id, pending_entry_id IS NULL
		FROM journal_entries
		WHERE public_ref = $1`

	var (
		ledgerID           int
		pendingEntryIsNull bool
	)
	if err := tx.QueryRowContext(t.Context(), query, got.Reference).Scan(&ledgerID, &pendingEntryIsNull); err != nil {
		t.Fatalf("read journal entry %s: %v", got.Reference, err)
	}
	if ledgerID != want.LedgerID {
		t.Errorf("entry ledger_id = %d, want %d", ledgerID, want.LedgerID)
	}
	if !pendingEntryIsNull {
		t.Error("entry pending_entry_id is set, want NULL")
	}
}

func readEntryLedgerID(t *testing.T, tx *sql.Tx, reference string) int {
	t.Helper()

	var ledgerID int
	if err := tx.QueryRowContext(
		t.Context(),
		`SELECT ledger_id FROM journal_entries WHERE public_ref = $1`,
		reference,
	).Scan(&ledgerID); err != nil {
		t.Fatalf("read journal entry %s ledger: %v", reference, err)
	}
	return ledgerID
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

// journalLineRow is the part of a journal_lines row the tests assert on; the
// entry is fixed by the lookup.
type journalLineRow struct {
	LedgerID        int
	Amount          int64
	DebitAccountID  int64
	CreditAccountID int64
	LineNumber      int
	Effect          string
	Purpose         string
}

func assertJournalLines(t *testing.T, tx *sql.Tx, entryReference string, want []journalLineRow) {
	t.Helper()

	const query = `
		SELECT line.ledger_id, line.amount, line.debit_account_id,
		       line.credit_account_id, line.line_number, line.effect, line.purpose
		FROM journal_lines line
		JOIN journal_entries entry ON entry.id = line.journal_entry_id
		WHERE entry.public_ref = $1
		ORDER BY line.line_number`

	rows, err := tx.QueryContext(t.Context(), query, entryReference)
	if err != nil {
		t.Fatalf("query journal lines: %v", err)
	}
	defer rows.Close()

	var got []journalLineRow
	for rows.Next() {
		var line journalLineRow
		if err := rows.Scan(
			&line.LedgerID,
			&line.Amount,
			&line.DebitAccountID,
			&line.CreditAccountID,
			&line.LineNumber,
			&line.Effect,
			&line.Purpose,
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

type accountMovementRow struct {
	Sequence     int64
	LineNumber   int
	Direction    string
	Amount       int64
	Purpose      string
	BalanceAfter int64
}

func assertAccountMovements(t *testing.T, tx *sql.Tx, accountID int64, want []accountMovementRow) {
	t.Helper()

	const query = `
		SELECT sequence, line_number, direction, amount, purpose, balance_after, recorded_at
		FROM account_movements
		WHERE account_id = $1
		ORDER BY sequence`

	rows, err := tx.QueryContext(t.Context(), query, accountID)
	if err != nil {
		t.Fatalf("query account movements: %v", err)
	}
	defer rows.Close()

	var (
		got      []accountMovementRow
		recorded []time.Time
	)
	for rows.Next() {
		var (
			row   accountMovementRow
			recAt time.Time
		)
		if err := rows.Scan(
			&row.Sequence,
			&row.LineNumber,
			&row.Direction,
			&row.Amount,
			&row.Purpose,
			&row.BalanceAfter,
			&recAt,
		); err != nil {
			t.Fatalf("scan account movement: %v", err)
		}
		got = append(got, row)
		recorded = append(recorded, recAt)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate account movements: %v", err)
	}

	if len(got) != len(want) {
		t.Fatalf("account movement count = %d, want %d", len(got), len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("account movement %d = %+v, want %+v", i, got[i], want[i])
		}
		if i > 0 && recorded[i].Before(recorded[i-1]) {
			t.Errorf("movement %d recorded_at (%v) < movement %d recorded_at (%v)", i, recorded[i], i-1, recorded[i-1])
		}
	}
}

// TestStore_PostEntry_AccountMovements verifies that an entry touching a payable
// account on multiple lines writes running-balance movements in line_number order
// with correct balance_after and sequence, while platform accounts without the
// records_movements flag record none.
func TestStore_PostEntry_AccountMovements(t *testing.T) {
	fixture := newPostEntryFixture(t)

	description := "Payment and processing fee"
	effectiveAt := time.Date(2026, time.September, 15, 10, 0, 0, 0, time.UTC)
	const (
		grossAmount int64 = 10_000
		feeAmount   int64 = 200
	)

	result := fixture.mustPost(t, journal.PostInput{
		LedgerSlug:  "ngn_ng",
		RequestID:   "req_movements_1",
		Kind:        "payment",
		Description: description,
		EffectiveAt: &effectiveAt,
		Lines: []journal.LineInput{
			{
				DebitAccountReference:  fixture.platform.Cash.Reference,
				CreditAccountReference: fixture.payable.Reference,
				Amount:                 grossAmount,
				Purpose:                "Card payment",
			},
			{
				DebitAccountReference:  fixture.payable.Reference,
				CreditAccountReference: fixture.platform.FeeRevenue.Reference,
				Amount:                 feeAmount,
				Purpose:                "Processing fee",
			},
		},
	})

	if !result.Created {
		t.Fatal("PostEntry() Created = false, want true")
	}

	// Payable account recorded 2 movements in line_number order:
	// Line 1: credit 10000, balance_after = 10000
	// Line 2: debit 200, balance_after = 9800
	assertAccountMovements(t, fixture.tx, fixture.payable.ID, []accountMovementRow{
		{
			Sequence:     1,
			LineNumber:   1,
			Direction:    "credit",
			Amount:       10_000,
			Purpose:      "Card payment",
			BalanceAfter: 10_000,
		},
		{
			Sequence:     2,
			LineNumber:   2,
			Direction:    "debit",
			Amount:       200,
			Purpose:      "Processing fee",
			BalanceAfter: 9_800,
		},
	})

	// Check accounts table movement_count
	var payableMovementCount, cashMovementCount, feeMovementCount int64
	if err := fixture.tx.QueryRowContext(t.Context(),
		`SELECT movement_count FROM accounts WHERE id = $1`, fixture.payable.ID,
	).Scan(&payableMovementCount); err != nil {
		t.Fatalf("query payable movement_count: %v", err)
	}
	if payableMovementCount != 2 {
		t.Errorf("payable movement_count = %d, want 2", payableMovementCount)
	}

	if err := fixture.tx.QueryRowContext(t.Context(),
		`SELECT movement_count FROM accounts WHERE id = $1`, fixture.platform.Cash.ID,
	).Scan(&cashMovementCount); err != nil {
		t.Fatalf("query cash movement_count: %v", err)
	}
	if cashMovementCount != 0 {
		t.Errorf("cash movement_count = %d, want 0", cashMovementCount)
	}

	if err := fixture.tx.QueryRowContext(t.Context(),
		`SELECT movement_count FROM accounts WHERE id = $1`, fixture.platform.FeeRevenue.ID,
	).Scan(&feeMovementCount); err != nil {
		t.Fatalf("query fee movement_count: %v", err)
	}
	if feeMovementCount != 0 {
		t.Errorf("fee movement_count = %d, want 0", feeMovementCount)
	}

	// Verify both movements for the payable account share the exact same recorded_at
	var rec1, rec2 time.Time
	if err := fixture.tx.QueryRowContext(t.Context(),
		`SELECT recorded_at FROM account_movements WHERE account_id = $1 AND sequence = 1`, fixture.payable.ID,
	).Scan(&rec1); err != nil {
		t.Fatalf("query sequence 1 recorded_at: %v", err)
	}
	if err := fixture.tx.QueryRowContext(t.Context(),
		`SELECT recorded_at FROM account_movements WHERE account_id = $1 AND sequence = 2`, fixture.payable.ID,
	).Scan(&rec2); err != nil {
		t.Fatalf("query sequence 2 recorded_at: %v", err)
	}
	if !rec1.Equal(rec2) {
		t.Errorf("movements in same entry have different recorded_at: %v vs %v", rec1, rec2)
	}
}

// TestStore_PostEntry_ReconciliationIdentity verifies that after any posting,
// the recorded account's latest balance_after equals credits_posted - debits_posted.
func TestStore_PostEntry_ReconciliationIdentity(t *testing.T) {
	fixture := newPostEntryFixture(t)

	operations := []struct {
		desc    string
		lines   []journal.LineInput
		wantBal int64
	}{
		{
			desc: "initial payment",
			lines: []journal.LineInput{
				{
					DebitAccountReference:  fixture.platform.Cash.Reference,
					CreditAccountReference: fixture.payable.Reference,
					Amount:                 50_000,
					Purpose:                "Initial card payment",
				},
			},
			wantBal: 50_000,
		},
		{
			desc: "fee debit",
			lines: []journal.LineInput{
				{
					DebitAccountReference:  fixture.payable.Reference,
					CreditAccountReference: fixture.platform.FeeRevenue.Reference,
					Amount:                 1_500,
					Purpose:                "Monthly fee",
				},
			},
			wantBal: 48_500,
		},
		{
			desc: "payout debit and processing fee",
			lines: []journal.LineInput{
				{
					DebitAccountReference:  fixture.payable.Reference,
					CreditAccountReference: fixture.platform.Cash.Reference,
					Amount:                 20_000,
					Purpose:                "Merchant withdrawal",
				},
				{
					DebitAccountReference:  fixture.payable.Reference,
					CreditAccountReference: fixture.platform.FeeRevenue.Reference,
					Amount:                 500,
					Purpose:                "Withdrawal fee",
				},
			},
			wantBal: 28_000,
		},
	}

	for i, op := range operations {
		eff := time.Date(2026, time.September, 15+i, 12, 0, 0, 0, time.UTC)
		fixture.mustPost(t, journal.PostInput{
			LedgerSlug:  "ngn_ng",
			RequestID:   fmt.Sprintf("req_recon_%d", i+1),
			Kind:        "payment",
			Description: op.desc,
			EffectiveAt: &eff,
			Lines:       op.lines,
		})

		var (
			creditsPosted int64
			debitsPosted  int64
			latestBalance int64
		)
		if err := fixture.tx.QueryRowContext(t.Context(),
			`SELECT credits_posted, debits_posted FROM accounts WHERE id = $1`, fixture.payable.ID,
		).Scan(&creditsPosted, &debitsPosted); err != nil {
			t.Fatalf("op %d query account counters: %v", i, err)
		}

		if err := fixture.tx.QueryRowContext(t.Context(),
			`SELECT balance_after FROM account_movements WHERE account_id = $1 ORDER BY sequence DESC LIMIT 1`,
			fixture.payable.ID,
		).Scan(&latestBalance); err != nil {
			t.Fatalf("op %d query latest balance_after: %v", i, err)
		}

		expectedPosted := creditsPosted - debitsPosted
		if latestBalance != expectedPosted {
			t.Errorf("op %d: latest balance_after = %d != (credits_posted - debits_posted = %d)",
				i, latestBalance, expectedPosted)
		}
		if latestBalance != op.wantBal {
			t.Errorf("op %d: latest balance_after = %d, want %d", i, latestBalance, op.wantBal)
		}
	}
}

// TestStore_PostEntry_SequenceGaplessAfterRollback verifies that sequence starts at 1
// and has no gaps even after a rolled-back posting attempt.
func TestStore_PostEntry_SequenceGaplessAfterRollback(t *testing.T) {
	fixture := newCommittedPostEntryFixture(t)

	// Posting 1: succeeds (sequence 1)
	eff1 := time.Date(2026, time.September, 15, 10, 0, 0, 0, time.UTC)
	fixture.mustPostCommitted(t, t.Context(), journal.PostInput{
		LedgerSlug:  fixture.slug,
		RequestID:   "req_gapless_1",
		Kind:        "payment",
		Description: "First successful payment",
		EffectiveAt: &eff1,
		Lines: []journal.LineInput{
			{
				DebitAccountReference:  fixture.platform.Cash.Reference,
				CreditAccountReference: fixture.payable.Reference,
				Amount:                 5_000,
				Purpose:                "Credit line",
			},
		},
	})

	// Posting 2: attempts to debit 10,000 (balance is 5,000) -> fails with insufficient funds!
	eff2 := time.Date(2026, time.September, 15, 11, 0, 0, 0, time.UTC)
	tx2, err := testDB.BeginTx(t.Context(), nil)
	if err != nil {
		t.Fatalf("begin tx2: %v", err)
	}
	store2 := postgres.New(tx2)
	_, err = store2.PostEntry(t.Context(), journal.PostInput{
		LedgerSlug:  fixture.slug,
		RequestID:   "req_gapless_2",
		Kind:        "payment",
		Description: "Failing debit payment",
		EffectiveAt: &eff2,
		Lines: []journal.LineInput{
			{
				DebitAccountReference:  fixture.payable.Reference,
				CreditAccountReference: fixture.platform.Cash.Reference,
				Amount:                 10_000,
				Purpose:                "Excessive debit",
			},
		},
	})
	if !errors.Is(err, journal.ErrInsufficientFunds) {
		t.Fatalf("expected ErrInsufficientFunds, got %v", err)
	}
	_ = tx2.Rollback()

	// Posting 3: succeeds (must receive sequence 2, NOT 3!)
	eff3 := time.Date(2026, time.September, 15, 12, 0, 0, 0, time.UTC)
	fixture.mustPostCommitted(t, t.Context(), journal.PostInput{
		LedgerSlug:  fixture.slug,
		RequestID:   "req_gapless_3",
		Kind:        "payment",
		Description: "Second successful payment",
		EffectiveAt: &eff3,
		Lines: []journal.LineInput{
			{
				DebitAccountReference:  fixture.platform.Cash.Reference,
				CreditAccountReference: fixture.payable.Reference,
				Amount:                 2_000,
				Purpose:                "Another credit",
			},
		},
	})

	verifyTx, err := testDB.BeginTx(t.Context(), nil)
	if err != nil {
		t.Fatalf("begin verifyTx: %v", err)
	}
	defer func() { _ = verifyTx.Rollback() }()

	assertAccountMovements(t, verifyTx, fixture.payable.ID, []accountMovementRow{
		{
			Sequence:     1,
			LineNumber:   1,
			Direction:    "credit",
			Amount:       5_000,
			Purpose:      "Credit line",
			BalanceAfter: 5_000,
		},
		{
			Sequence:     2,
			LineNumber:   1,
			Direction:    "credit",
			Amount:       2_000,
			Purpose:      "Another credit",
			BalanceAfter: 7_000,
		},
	})

	var movCount int64
	if err := verifyTx.QueryRowContext(t.Context(),
		`SELECT movement_count FROM accounts WHERE id = $1`, fixture.payable.ID,
	).Scan(&movCount); err != nil {
		t.Fatalf("query movement_count: %v", err)
	}
	if movCount != 2 {
		t.Errorf("movement_count = %d, want 2 (gapless)", movCount)
	}
}
