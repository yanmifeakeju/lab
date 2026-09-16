//go:build integration

package postgres_test

import (
	"database/sql"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/oklog/ulid/v2"

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
	if got.ClosedAt != nil {
		t.Errorf("CreatePayableAccount() Account.ClosedAt = %v, want nil", got.ClosedAt)
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
		if got.ClosedAt != nil {
			t.Errorf("GetPayableAccount() ClosedAt = %v, want nil", got.ClosedAt)
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
		cash := seedPlatformAccount(t, tx, ledgerID, "cash")

		_, err := store.GetPayableAccount(t.Context(), account.GetPayableInput{
			Reference: cash.Reference,
		})
		if !errors.Is(err, account.ErrAccountNotFound) {
			t.Errorf("GetPayableAccount() error = %v, want %v", err, account.ErrAccountNotFound)
		}
	})

	t.Run("internal fee revenue account reference returns account not found", func(t *testing.T) {
		feeRevenue := seedPlatformAccount(t, tx, ledgerID, "fee_revenue")

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
			`UPDATE accounts SET closed_at = clock_timestamp() WHERE public_ref = $1`,
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
		if got.ClosedAt == nil {
			t.Error("GetPayableAccount() ClosedAt = nil, want timestamp")
		}
	})
}

func TestAccountModel_RecordsMovements(t *testing.T) {
	ctx := t.Context()

	t.Run("create_payable_account sets records_movements to true", func(t *testing.T) {
		tx := newTestTx(t)
		seedLedger(t, tx, "ngn_ng", "NGN")
		store := postgres.New(tx)

		res, err := store.CreatePayableAccount(ctx, account.CreatePayableInput{
			LedgerSlug: "ngn_ng",
			ExternalID: "merchant_rm_test",
			Name:       "RM Merchant Ltd",
		})
		if err != nil {
			t.Fatalf("create payable account: %v", err)
		}

		var recordsMovements bool
		if err := tx.QueryRowContext(
			ctx,
			`SELECT records_movements FROM accounts WHERE public_ref = $1`,
			res.Account.Reference,
		).Scan(&recordsMovements); err != nil {
			t.Fatalf("query records_movements: %v", err)
		}
		if !recordsMovements {
			t.Error("payable account records_movements = false, want true")
		}
	})

	t.Run("payable account cannot be created with records_movements = false", func(t *testing.T) {
		tx := newTestTx(t)
		ledgerID := seedLedger(t, tx, "ngn_ng", "NGN")

		holderRef := "hld_" + ulid.Make().String()
		accountRef := "acct_" + ulid.Make().String()

		var holderID int64
		if err := tx.QueryRowContext(
			ctx,
			`INSERT INTO holders (public_ref, external_id, name) VALUES ($1, $2, $3) RETURNING id`,
			holderRef, "holder_rm_false", "Holder RM False",
		).Scan(&holderID); err != nil {
			t.Fatalf("insert holder: %v", err)
		}

		_, err := tx.ExecContext(
			ctx,
			`INSERT INTO accounts (public_ref, ledger_id, kind, holder_id, records_movements)
			 VALUES ($1, $2, 'payable', $3, false)`,
			accountRef, ledgerID, holderID,
		)
		if err == nil {
			t.Fatal("insert payable account with records_movements = false succeeded, want check constraint violation")
		}
	})

	t.Run("updating payable records_movements to false is rejected", func(t *testing.T) {
		tx := newTestTx(t)
		seedLedger(t, tx, "ngn_ng", "NGN")
		store := postgres.New(tx)

		res, err := store.CreatePayableAccount(ctx, account.CreatePayableInput{
			LedgerSlug: "ngn_ng",
			ExternalID: "merchant_rm_upd",
			Name:       "Upd Merchant Ltd",
		})
		if err != nil {
			t.Fatalf("create payable account: %v", err)
		}

		_, err = tx.ExecContext(
			ctx,
			`UPDATE accounts SET records_movements = false WHERE public_ref = $1`,
			res.Account.Reference,
		)
		if err == nil {
			t.Fatal("updating payable records_movements to false succeeded, want trigger error")
		}
	})

	t.Run("updating platform records_movements from false to true is rejected", func(t *testing.T) {
		tx := newTestTx(t)
		ledgerID := seedLedger(t, tx, "ngn_ng", "NGN")

		platRef := "acct_" + ulid.Make().String()
		if _, err := tx.ExecContext(
			ctx,
			`INSERT INTO accounts (public_ref, ledger_id, kind, label, records_movements)
			 VALUES ($1, $2, 'platform', 'cash', false)`,
			platRef, ledgerID,
		); err != nil {
			t.Fatalf("insert platform account: %v", err)
		}

		_, err := tx.ExecContext(
			ctx,
			`UPDATE accounts SET records_movements = true WHERE public_ref = $1`,
			platRef,
		)
		if err == nil {
			t.Fatal("updating platform records_movements from false to true succeeded, want trigger error")
		}
	})

	t.Run("updating platform records_movements from true to false is rejected", func(t *testing.T) {
		tx := newTestTx(t)
		ledgerID := seedLedger(t, tx, "ngn_ng", "NGN")

		platRef := "acct_" + ulid.Make().String()
		if _, err := tx.ExecContext(
			ctx,
			`INSERT INTO accounts (public_ref, ledger_id, kind, label, records_movements)
			 VALUES ($1, $2, 'platform', 'fee_revenue', true)`,
			platRef, ledgerID,
		); err != nil {
			t.Fatalf("insert platform account with rm=true: %v", err)
		}

		_, err := tx.ExecContext(
			ctx,
			`UPDATE accounts SET records_movements = false WHERE public_ref = $1`,
			platRef,
		)
		if err == nil {
			t.Fatal("updating platform records_movements from true to false succeeded, want trigger error")
		}
	})
}

func TestAccountModel_ClosedAtTransitions(t *testing.T) {
	ctx := t.Context()

	t.Run("future closed_at can be scheduled, moved, or cleared", func(t *testing.T) {
		tx := newTestTx(t)
		seedLedger(t, tx, "ngn_ng", "NGN")
		store := postgres.New(tx)

		res, err := store.CreatePayableAccount(ctx, account.CreatePayableInput{
			LedgerSlug: "ngn_ng",
			ExternalID: "merchant_closed_at_sched",
			Name:       "Closed At Merchant Ltd",
		})
		if err != nil {
			t.Fatalf("create payable account: %v", err)
		}
		ref := res.Account.Reference

		// Schedule close in 1 hour
		if _, err := tx.ExecContext(
			ctx,
			`UPDATE accounts SET closed_at = clock_timestamp() + interval '1 hour' WHERE public_ref = $1`,
			ref,
		); err != nil {
			t.Fatalf("schedule future closed_at: %v", err)
		}

		// Move future close to 2 hours
		if _, err := tx.ExecContext(
			ctx,
			`UPDATE accounts SET closed_at = clock_timestamp() + interval '2 hours' WHERE public_ref = $1`,
			ref,
		); err != nil {
			t.Fatalf("move future closed_at: %v", err)
		}

		// Clear future close
		if _, err := tx.ExecContext(
			ctx,
			`UPDATE accounts SET closed_at = NULL WHERE public_ref = $1`,
			ref,
		); err != nil {
			t.Fatalf("clear future closed_at: %v", err)
		}
	})

	t.Run("updating other columns on reached closed account succeeds", func(t *testing.T) {
		tx := newTestTx(t)
		seedLedger(t, tx, "ngn_ng", "NGN")
		store := postgres.New(tx)

		res, err := store.CreatePayableAccount(ctx, account.CreatePayableInput{
			LedgerSlug: "ngn_ng",
			ExternalID: "merchant_closed_at_reached",
			Name:       "Closed At Merchant Ltd",
		})
		if err != nil {
			t.Fatalf("create payable account: %v", err)
		}
		ref := res.Account.Reference

		// Close account now
		if _, err := tx.ExecContext(
			ctx,
			`UPDATE accounts SET closed_at = clock_timestamp() WHERE public_ref = $1`,
			ref,
		); err != nil {
			t.Fatalf("set reached closed_at: %v", err)
		}

		// Updating other columns on a reached-closed account is still allowed
		if _, err := tx.ExecContext(
			ctx,
			`UPDATE accounts SET description = 'closed account desc' WHERE public_ref = $1`,
			ref,
		); err != nil {
			t.Fatalf("updating description on reached closed account failed: %v", err)
		}
	})

	t.Run("clearing reached closed_at fails", func(t *testing.T) {
		tx := newTestTx(t)
		seedLedger(t, tx, "ngn_ng", "NGN")
		store := postgres.New(tx)
		res, err := store.CreatePayableAccount(ctx, account.CreatePayableInput{
			LedgerSlug: "ngn_ng",
			ExternalID: "merchant_clear_fail",
			Name:       "Clear Fail Ltd",
		})
		if err != nil {
			t.Fatalf("create payable account: %v", err)
		}
		if _, err := tx.ExecContext(
			ctx,
			`UPDATE accounts SET closed_at = clock_timestamp() WHERE public_ref = $1`,
			res.Account.Reference,
		); err != nil {
			t.Fatalf("set reached closed_at: %v", err)
		}

		_, err = tx.ExecContext(
			ctx,
			`UPDATE accounts SET closed_at = NULL WHERE public_ref = $1`,
			res.Account.Reference,
		)
		if err == nil {
			t.Fatal("clearing reached closed_at succeeded, want trigger error")
		}
	})

	t.Run("moving reached closed_at fails", func(t *testing.T) {
		tx := newTestTx(t)
		seedLedger(t, tx, "ngn_ng", "NGN")
		store := postgres.New(tx)
		res, err := store.CreatePayableAccount(ctx, account.CreatePayableInput{
			LedgerSlug: "ngn_ng",
			ExternalID: "merchant_move_fail",
			Name:       "Move Fail Ltd",
		})
		if err != nil {
			t.Fatalf("create payable account: %v", err)
		}
		if _, err := tx.ExecContext(
			ctx,
			`UPDATE accounts SET closed_at = clock_timestamp() WHERE public_ref = $1`,
			res.Account.Reference,
		); err != nil {
			t.Fatalf("set reached closed_at: %v", err)
		}

		_, err = tx.ExecContext(
			ctx,
			`UPDATE accounts SET closed_at = clock_timestamp() + interval '1 hour' WHERE public_ref = $1`,
			res.Account.Reference,
		)
		if err == nil {
			t.Fatal("moving reached closed_at to future succeeded, want trigger error")
		}
	})

	t.Run("setting closed_at to a past time rounds up to current time on update", func(t *testing.T) {
		tx := newTestTx(t)
		seedLedger(t, tx, "ngn_ng", "NGN")
		store := postgres.New(tx)

		res, err := store.CreatePayableAccount(ctx, account.CreatePayableInput{
			LedgerSlug: "ngn_ng",
			ExternalID: "merchant_past_round",
			Name:       "Past Round Ltd",
		})
		if err != nil {
			t.Fatalf("create payable account: %v", err)
		}
		ref := res.Account.Reference

		var dbNow time.Time
		if err := tx.QueryRowContext(ctx, `SELECT clock_timestamp()`).Scan(&dbNow); err != nil {
			t.Fatalf("query clock_timestamp: %v", err)
		}

		// Set closed_at to 1 hour in the past
		if _, err := tx.ExecContext(
			ctx,
			`UPDATE accounts SET closed_at = clock_timestamp() - interval '1 hour' WHERE public_ref = $1`,
			ref,
		); err != nil {
			t.Fatalf("update past closed_at: %v", err)
		}

		var closedAt time.Time
		if err := tx.QueryRowContext(
			ctx,
			`SELECT closed_at FROM accounts WHERE public_ref = $1`,
			ref,
		).Scan(&closedAt); err != nil {
			t.Fatalf("query closed_at: %v", err)
		}

		if closedAt.Before(dbNow) {
			t.Errorf("closed_at = %v was not rounded up to current time (dbNow = %v)", closedAt, dbNow)
		}
	})

	t.Run("pulling scheduled future closed_at into past rounds up to current time", func(t *testing.T) {
		tx := newTestTx(t)
		seedLedger(t, tx, "ngn_ng", "NGN")
		store := postgres.New(tx)

		res, err := store.CreatePayableAccount(ctx, account.CreatePayableInput{
			LedgerSlug: "ngn_ng",
			ExternalID: "merchant_pull_future_past",
			Name:       "Pull Future Past Ltd",
		})
		if err != nil {
			t.Fatalf("create payable account: %v", err)
		}
		ref := res.Account.Reference

		// Schedule close in 2 hours
		if _, err := tx.ExecContext(
			ctx,
			`UPDATE accounts SET closed_at = clock_timestamp() + interval '2 hours' WHERE public_ref = $1`,
			ref,
		); err != nil {
			t.Fatalf("schedule future closed_at: %v", err)
		}

		var dbNow time.Time
		if err := tx.QueryRowContext(ctx, `SELECT clock_timestamp()`).Scan(&dbNow); err != nil {
			t.Fatalf("query clock_timestamp: %v", err)
		}

		// Pull scheduled close into the past
		if _, err := tx.ExecContext(
			ctx,
			`UPDATE accounts SET closed_at = clock_timestamp() - interval '1 hour' WHERE public_ref = $1`,
			ref,
		); err != nil {
			t.Fatalf("pull future closed_at to past: %v", err)
		}

		var closedAt time.Time
		if err := tx.QueryRowContext(
			ctx,
			`SELECT closed_at FROM accounts WHERE public_ref = $1`,
			ref,
		).Scan(&closedAt); err != nil {
			t.Fatalf("query closed_at: %v", err)
		}

		if closedAt.Before(dbNow) {
			t.Errorf("closed_at = %v was not rounded up to current time (dbNow = %v)", closedAt, dbNow)
		}
	})

	t.Run("inserting account with past closed_at rounds up to current time", func(t *testing.T) {
		tx := newTestTx(t)
		ledgerID := seedLedger(t, tx, "ngn_ng", "NGN")
		ref := "acct_" + ulid.Make().String()

		var dbNow time.Time
		if err := tx.QueryRowContext(ctx, `SELECT clock_timestamp()`).Scan(&dbNow); err != nil {
			t.Fatalf("query clock_timestamp: %v", err)
		}

		if _, err := tx.ExecContext(
			ctx,
			`INSERT INTO accounts (public_ref, ledger_id, kind, label, closed_at)
			 VALUES ($1, $2, 'platform', 'cash', clock_timestamp() - interval '2 days')`,
			ref, ledgerID,
		); err != nil {
			t.Fatalf("insert platform account with past closed_at: %v", err)
		}

		var closedAt time.Time
		if err := tx.QueryRowContext(
			ctx,
			`SELECT closed_at FROM accounts WHERE public_ref = $1`,
			ref,
		).Scan(&closedAt); err != nil {
			t.Fatalf("query closed_at: %v", err)
		}

		if closedAt.Before(dbNow) {
			t.Errorf("closed_at = %v was not rounded up to current time (dbNow = %v)", closedAt, dbNow)
		}
	})
}

func TestAccountModel_PlatformAccountsAndLabels(t *testing.T) {
	ctx := t.Context()

	t.Run("multiple platform accounts with same label in same ledger succeed", func(t *testing.T) {
		tx := newTestTx(t)
		ledgerID := seedLedger(t, tx, "ngn_ng", "NGN")

		ref1 := "acct_" + ulid.Make().String()
		ref2 := "acct_" + ulid.Make().String()

		if _, err := tx.ExecContext(
			ctx,
			`INSERT INTO accounts (public_ref, ledger_id, kind, label) VALUES ($1, $2, 'platform', 'cash')`,
			ref1, ledgerID,
		); err != nil {
			t.Fatalf("insert first platform account: %v", err)
		}

		if _, err := tx.ExecContext(
			ctx,
			`INSERT INTO accounts (public_ref, ledger_id, kind, label) VALUES ($1, $2, 'platform', 'cash')`,
			ref2, ledgerID,
		); err != nil {
			t.Fatalf("insert second platform account with same label: %v", err)
		}
	})

	t.Run("platform account requires label", func(t *testing.T) {
		tx := newTestTx(t)
		ledgerID := seedLedger(t, tx, "ngn_ng", "NGN")

		ref := "acct_" + ulid.Make().String()
		_, err := tx.ExecContext(
			ctx,
			`INSERT INTO accounts (public_ref, ledger_id, kind, label) VALUES ($1, $2, 'platform', NULL)`,
			ref, ledgerID,
		)
		if err == nil {
			t.Fatal("insert platform account with NULL label succeeded, want check constraint violation")
		}
	})

	t.Run("platform account label cannot be blank or exceed 64 characters", func(t *testing.T) {
		tx1 := newTestTx(t)
		ledgerID1 := seedLedger(t, tx1, "ngn_ng", "NGN")

		ref1 := "acct_" + ulid.Make().String()
		_, err := tx1.ExecContext(
			ctx,
			`INSERT INTO accounts (public_ref, ledger_id, kind, label) VALUES ($1, $2, 'platform', '   ')`,
			ref1, ledgerID1,
		)
		if err == nil {
			t.Fatal("insert platform account with blank label succeeded, want check constraint violation")
		}

		tx2 := newTestTx(t)
		ledgerID2 := seedLedger(t, tx2, "ngn_ng", "NGN")
		ref2 := "acct_" + ulid.Make().String()
		longLabel := strings.Repeat("a", 65)
		_, err = tx2.ExecContext(
			ctx,
			`INSERT INTO accounts (public_ref, ledger_id, kind, label) VALUES ($1, $2, 'platform', $3)`,
			ref2, ledgerID2, longLabel,
		)
		if err == nil {
			t.Fatal("insert platform account with > 64 char label succeeded, want check constraint violation")
		}
	})

	t.Run("payable account cannot have a label", func(t *testing.T) {
		tx := newTestTx(t)
		ledgerID := seedLedger(t, tx, "ngn_ng", "NGN")

		holderRef := "hld_" + ulid.Make().String()
		accountRef := "acct_" + ulid.Make().String()

		var holderID int64
		if err := tx.QueryRowContext(
			ctx,
			`INSERT INTO holders (public_ref, external_id, name) VALUES ($1, $2, $3) RETURNING id`,
			holderRef, "holder_label_test", "Holder Label Test",
		).Scan(&holderID); err != nil {
			t.Fatalf("insert holder: %v", err)
		}

		_, err := tx.ExecContext(
			ctx,
			`INSERT INTO accounts (public_ref, ledger_id, kind, holder_id, label, records_movements)
			 VALUES ($1, $2, 'payable', $3, 'some_label', true)`,
			accountRef, ledgerID, holderID,
		)
		if err == nil {
			t.Fatal("insert payable account with label succeeded, want check constraint violation")
		}
	})

	t.Run("invalid account kind is rejected", func(t *testing.T) {
		tx := newTestTx(t)
		ledgerID := seedLedger(t, tx, "ngn_ng", "NGN")

		ref := "acct_" + ulid.Make().String()
		_, err := tx.ExecContext(
			ctx,
			`INSERT INTO accounts (public_ref, ledger_id, kind) VALUES ($1, $2, 'cash')`,
			ref, ledgerID,
		)
		if err == nil {
			t.Fatal("insert account with old kind 'cash' succeeded, want check constraint violation")
		}
	})
}
