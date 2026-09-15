//go:build integration

package postgres_test

import (
	"database/sql"
	"errors"
	"strings"
	"testing"

	"yanmifeakeju.com/ledger/internal/account"
	"yanmifeakeju.com/ledger/internal/postgres"
)

func TestStore_CreatePayableAccount(t *testing.T) {
	tx := newTestTx(t)
	seedLedger(t, tx, "ngn_ng", "NGN")
	store := postgres.New(tx)

	result, err := store.CreatePayableAccount(t.Context(), account.CreatePayableInput{
		LedgerSlug: "ngn_ng",
		ExternalID: "merchant_1",
		Name:       "Acme Ltd",
	})
	if err != nil {
		t.Fatalf("CreatePayableAccount() error = %v", err)
	}

	if !result.Created {
		t.Error("CreatePayableAccount() Created = false, want true")
	}

	got := result.Account
	if !strings.HasPrefix(got.Reference, "acct_") {
		t.Errorf("CreatePayableAccount() Account.Reference = %q, want acct_ prefix", got.Reference)
	}
	if got.LedgerSlug != "ngn_ng" {
		t.Errorf("CreatePayableAccount() Account.LedgerSlug = %q, want %q", got.LedgerSlug, "ngn_ng")
	}
	if !strings.HasPrefix(got.HolderReference, "hld_") {
		t.Errorf(
			"CreatePayableAccount() Account.HolderReference = %q, want hld_ prefix",
			got.HolderReference,
		)
	}
	if got.HolderName != "Acme Ltd" {
		t.Errorf("CreatePayableAccount() Account.HolderName = %q, want %q", got.HolderName, "Acme Ltd")
	}
	if got.IsClosed {
		t.Error("CreatePayableAccount() Account.IsClosed = true, want false")
	}
	if got.CreatedAt.IsZero() {
		t.Error("CreatePayableAccount() Account.CreatedAt is zero, want database timestamp")
	}
	if got.Balances != (account.BalanceCounters{}) {
		t.Errorf("CreatePayableAccount() account counters are not zero: %+v", got)
	}
}

// TestStore_CreatePayableAccount_IdempotentRetry verifies that retrying the
// same onboarding request returns the original holder and payable account.
func TestStore_CreatePayableAccount_IdempotentRetry(t *testing.T) {
	tx := newTestTx(t)
	seedLedger(t, tx, "ngn_ng", "NGN")
	store := postgres.New(tx)

	input := account.CreatePayableInput{
		LedgerSlug: "ngn_ng",
		ExternalID: "merchant_2",
		Name:       "Acme Ltd",
	}

	first, err := store.CreatePayableAccount(t.Context(), input)
	if err != nil {
		t.Fatalf("first CreatePayableAccount() error = %v", err)
	}
	if !first.Created {
		t.Error("first CreatePayableAccount() Created = false, want true")
	}

	second, err := store.CreatePayableAccount(t.Context(), input)
	if err != nil {
		t.Fatalf("retry CreatePayableAccount() error = %v", err)
	}
	if second.Created {
		t.Error("retry CreatePayableAccount() Created = true, want false")
	}

	if second.Account.Reference != first.Account.Reference {
		t.Errorf(
			"retry CreatePayableAccount() Account.Reference = %q, want %q",
			second.Account.Reference,
			first.Account.Reference,
		)
	}
	if second.Account.HolderReference != first.Account.HolderReference {
		t.Errorf(
			"retry CreatePayableAccount() Account.HolderReference = %q, want %q",
			second.Account.HolderReference,
			first.Account.HolderReference,
		)
	}
}

// TestStore_CreatePayableAccount_SameHolderAcrossLedgers verifies that one
// holder receives distinct payable accounts in each ledger.
func TestStore_CreatePayableAccount_SameHolderAcrossLedgers(t *testing.T) {
	tx := newTestTx(t)
	seedLedger(t, tx, "ngn_ng", "NGN")
	seedLedger(t, tx, "usd_ng", "USD")
	store := postgres.New(tx)

	ngnResult, err := store.CreatePayableAccount(t.Context(), account.CreatePayableInput{
		LedgerSlug: "ngn_ng",
		ExternalID: "merchant_1",
		Name:       "Acme Ltd",
	})
	if err != nil {
		t.Fatalf("NGN CreatePayableAccount() error = %v", err)
	}
	if !ngnResult.Created {
		t.Error("NGN CreatePayableAccount() Created = false, want true")
	}
	if ngnResult.Account.LedgerSlug != "ngn_ng" {
		t.Errorf(
			"NGN CreatePayableAccount() Account.LedgerSlug = %q, want %q",
			ngnResult.Account.LedgerSlug,
			"ngn_ng",
		)
	}

	usdResult, err := store.CreatePayableAccount(t.Context(), account.CreatePayableInput{
		LedgerSlug: "usd_ng",
		ExternalID: "merchant_1",
		Name:       "Acme Ltd",
	})
	if err != nil {
		t.Fatalf("USD CreatePayableAccount() error = %v", err)
	}
	if !usdResult.Created {
		t.Error("USD CreatePayableAccount() Created = false, want true")
	}
	if usdResult.Account.LedgerSlug != "usd_ng" {
		t.Errorf(
			"USD CreatePayableAccount() Account.LedgerSlug = %q, want %q",
			usdResult.Account.LedgerSlug,
			"usd_ng",
		)
	}
	if usdResult.Account.Reference == ngnResult.Account.Reference {
		t.Errorf(
			"accounts share reference %q, want different references for different ledgers",
			usdResult.Account.Reference,
		)
	}
	if usdResult.Account.HolderReference != ngnResult.Account.HolderReference {
		t.Errorf(
			"USD CreatePayableAccount() Account.HolderReference = %q, want %q",
			usdResult.Account.HolderReference,
			ngnResult.Account.HolderReference,
		)
	}
}

func TestStore_CreatePayableAccount_Errors(t *testing.T) {
	tests := []struct {
		name    string
		arrange func(*testing.T, *sql.Tx, *postgres.Store)
		input   account.CreatePayableInput
		wantErr error
	}{
		{
			name: "ledger not found",
			input: account.CreatePayableInput{
				LedgerSlug: "missing",
				ExternalID: "merchant_3",
				Name:       "Acme Ltd",
			},
			wantErr: account.ErrLedgerNotFound,
		},
		{
			name: "ledger closed",
			arrange: func(t *testing.T, tx *sql.Tx, _ *postgres.Store) {
				t.Helper()
				seedLedger(t, tx, "ngn_ng", "NGN")

				if _, err := tx.ExecContext(
					t.Context(),
					`UPDATE ledgers SET is_closed = true WHERE slug = $1`,
					"ngn_ng",
				); err != nil {
					t.Fatalf("close ledger: %v", err)
				}
			},
			input: account.CreatePayableInput{
				LedgerSlug: "ngn_ng",
				ExternalID: "merchant_4",
				Name:       "Acme Ltd",
			},
			wantErr: account.ErrLedgerClosed,
		},
		{
			name: "holder conflict",
			arrange: func(t *testing.T, tx *sql.Tx, store *postgres.Store) {
				t.Helper()
				seedLedger(t, tx, "ngn_ng", "NGN")

				_, err := store.CreatePayableAccount(t.Context(), account.CreatePayableInput{
					LedgerSlug: "ngn_ng",
					ExternalID: "merchant_5",
					Name:       "Acme Ltd",
				})
				if err != nil {
					t.Fatalf("arrange holder: %v", err)
				}
			},
			input: account.CreatePayableInput{
				LedgerSlug: "ngn_ng",
				ExternalID: "merchant_5",
				Name:       "Different Name",
			},
			wantErr: account.ErrHolderConflict,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tx := newTestTx(t)
			store := postgres.New(tx)

			if tt.arrange != nil {
				tt.arrange(t, tx, store)
			}

			_, err := store.CreatePayableAccount(t.Context(), tt.input)
			if !errors.Is(err, tt.wantErr) {
				t.Errorf("CreatePayableAccount() error = %v, want %v", err, tt.wantErr)
			}
		})
	}
}

func TestStore_GetPayableAccount(t *testing.T) {
	tx := newTestTx(t)
	store := postgres.New(tx)
	ledgerID := seedLedger(t, tx, "ngn_ng", "NGN")

	created, err := store.CreatePayableAccount(t.Context(), account.CreatePayableInput{
		LedgerSlug: "ngn_ng",
		ExternalID: "merchant_1",
		Name:       "Acme Ltd",
	})
	if err != nil {
		t.Fatalf("arrange payable account: %v", err)
	}

	t.Run("account found with zero balances", func(t *testing.T) {
		got, err := store.GetPayableAccount(t.Context(), account.GetPayableInput{
			Reference: created.Account.Reference,
		})
		if err != nil {
			t.Fatalf("GetPayableAccount() error = %v", err)
		}

		if got.Reference != created.Account.Reference {
			t.Errorf("GetPayableAccount() Reference = %q, want %q", got.Reference, created.Account.Reference)
		}
		if got.LedgerSlug != "ngn_ng" {
			t.Errorf("GetPayableAccount() LedgerSlug = %q, want %q", got.LedgerSlug, "ngn_ng")
		}
		if got.HolderReference != created.Account.HolderReference {
			t.Errorf("GetPayableAccount() HolderReference = %q, want %q", got.HolderReference, created.Account.HolderReference)
		}
		if got.HolderName != created.Account.HolderName {
			t.Errorf("GetPayableAccount() HolderName = %q, want %q", got.HolderName, created.Account.HolderName)
		}
		if got.IsClosed {
			t.Error("GetPayableAccount() IsClosed = true, want false")
		}
		if !got.CreatedAt.Equal(created.Account.CreatedAt) {
			t.Errorf("GetPayableAccount() CreatedAt = %v, want %v", got.CreatedAt, created.Account.CreatedAt)
		}
		if got.Balances.DebitsPending != 0 || got.Balances.CreditsPending != 0 ||
			got.Balances.DebitsPosted != 0 || got.Balances.CreditsPosted != 0 {
			t.Errorf("GetPayableAccount() Balances = %+v, want all zeros", got.Balances)
		}
		if got.Available() != 0 {
			t.Errorf("GetPayableAccount() Available() = %d, want 0", got.Available())
		}
	})

	t.Run("account found with balances and derived available", func(t *testing.T) {
		funded, err := store.CreatePayableAccount(t.Context(), account.CreatePayableInput{
			LedgerSlug: "ngn_ng",
			ExternalID: "merchant_funded",
			Name:       "Funded Merchant",
		})
		if err != nil {
			t.Fatalf("arrange funded account: %v", err)
		}

		// credits_posted=10000, debits_posted=100, debits_pending=200, credits_pending=500
		// available = credits_posted - debits_posted - debits_pending = 10000 - 100 - 200 = 9700
		const update = `
			UPDATE accounts
			SET credits_posted = 10000, debits_posted = 100, debits_pending = 200, credits_pending = 500
			WHERE public_ref = $1`
		if _, err := tx.ExecContext(t.Context(), update, funded.Account.Reference); err != nil {
			t.Fatalf("update account balances: %v", err)
		}

		got, err := store.GetPayableAccount(t.Context(), account.GetPayableInput{
			Reference: funded.Account.Reference,
		})
		if err != nil {
			t.Fatalf("GetPayableAccount() error = %v", err)
		}

		wantBalances := account.BalanceCounters{
			DebitsPending:  200,
			CreditsPending: 500,
			DebitsPosted:   100,
			CreditsPosted:  10000,
		}
		if got.Balances != wantBalances {
			t.Errorf("GetPayableAccount() Balances = %+v, want %+v", got.Balances, wantBalances)
		}
		const wantAvailable = uint64(9700)
		if got.Available() != wantAvailable {
			t.Errorf("GetPayableAccount() Available() = %d, want %d", got.Available(), wantAvailable)
		}
	})

	t.Run("account not found", func(t *testing.T) {
		_, err := store.GetPayableAccount(t.Context(), account.GetPayableInput{
			Reference: "acct_01K00000000000000000000000",
		})
		if !errors.Is(err, account.ErrAccountNotFound) {
			t.Errorf("GetPayableAccount() error = %v, want %v", err, account.ErrAccountNotFound)
		}
	})

	t.Run("internal cash account reference returns account not found", func(t *testing.T) {
		cash := seedPlatformAccount(t, tx, ledgerID, account.KindCash)

		_, err := store.GetPayableAccount(t.Context(), account.GetPayableInput{
			Reference: cash.Reference,
		})
		if !errors.Is(err, account.ErrAccountNotFound) {
			t.Errorf("GetPayableAccount() error = %v, want %v", err, account.ErrAccountNotFound)
		}
	})

	t.Run("internal fee revenue account reference returns account not found", func(t *testing.T) {
		feeRevenue := seedPlatformAccount(t, tx, ledgerID, account.KindFeeRevenue)

		_, err := store.GetPayableAccount(t.Context(), account.GetPayableInput{
			Reference: feeRevenue.Reference,
		})
		if !errors.Is(err, account.ErrAccountNotFound) {
			t.Errorf("GetPayableAccount() error = %v, want %v", err, account.ErrAccountNotFound)
		}
	})

	t.Run("account in another ledger is found by reference", func(t *testing.T) {
		seedLedger(t, tx, "usd_ng", "USD")
		usdAcct, err := store.CreatePayableAccount(t.Context(), account.CreatePayableInput{
			LedgerSlug: "usd_ng",
			ExternalID: "merchant_usd",
			Name:       "USD Merchant",
		})
		if err != nil {
			t.Fatalf("create USD account: %v", err)
		}
		got, err := store.GetPayableAccount(t.Context(), account.GetPayableInput{
			Reference: usdAcct.Account.Reference,
		})
		if err != nil {
			t.Fatalf("GetPayableAccount() error = %v", err)
		}
		if got.LedgerSlug != "usd_ng" {
			t.Errorf("LedgerSlug = %q, want usd_ng", got.LedgerSlug)
		}
	})

	t.Run("closed payable account is returned", func(t *testing.T) {
		closed, err := store.CreatePayableAccount(t.Context(), account.CreatePayableInput{
			LedgerSlug: "ngn_ng",
			ExternalID: "merchant_closed",
			Name:       "Closed Merchant Ltd",
		})
		if err != nil {
			t.Fatalf("arrange closed account: %v", err)
		}

		if _, err := tx.ExecContext(
			t.Context(),
			`UPDATE accounts SET is_closed = true WHERE public_ref = $1`,
			closed.Account.Reference,
		); err != nil {
			t.Fatalf("close account: %v", err)
		}

		got, err := store.GetPayableAccount(t.Context(), account.GetPayableInput{
			Reference: closed.Account.Reference,
		})
		if err != nil {
			t.Fatalf("GetPayableAccount() error = %v", err)
		}
		if !got.IsClosed {
			t.Error("GetPayableAccount() IsClosed = false, want true")
		}
	})
}
