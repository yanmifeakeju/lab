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
	ledgerID := seedLedger(t, tx, "ngn_ng", "NGN")
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
	if got.ID == 0 {
		t.Error("CreatePayableAccount() Account.ID = 0, want generated ID")
	}
	if !strings.HasPrefix(got.Reference, "acct_") {
		t.Errorf("CreatePayableAccount() Account.Reference = %q, want acct_ prefix", got.Reference)
	}
	if got.LedgerID != ledgerID {
		t.Errorf("CreatePayableAccount() Account.LedgerID = %d, want %d", got.LedgerID, ledgerID)
	}
	if got.Kind != account.AccountKindPayable {
		t.Errorf("CreatePayableAccount() Account.Kind = %q, want %q", got.Kind, account.AccountKindPayable)
	}
	if got.Channel != nil {
		t.Errorf("CreatePayableAccount() Account.Channel = %q, want nil", *got.Channel)
	}
	if got.HolderID == nil {
		t.Fatal("CreatePayableAccount() Account.HolderID = nil, want generated ID")
	}
	if *got.HolderID == 0 {
		t.Error("CreatePayableAccount() Account.HolderID = 0, want generated ID")
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
	if got.Description != nil {
		t.Errorf("CreatePayableAccount() Account.Description = %q, want nil", *got.Description)
	}
	if !got.DebitsMustNotExceedCredits {
		t.Error("CreatePayableAccount() Account.DebitsMustNotExceedCredits = false, want true")
	}
	if got.CreditsMustNotExceedDebits {
		t.Error("CreatePayableAccount() Account.CreditsMustNotExceedDebits = true, want false")
	}
	if got.IsClosed {
		t.Error("CreatePayableAccount() Account.IsClosed = true, want false")
	}
	if got.CreatedAt.IsZero() {
		t.Error("CreatePayableAccount() Account.CreatedAt is zero, want database timestamp")
	}
	if got.DebitsPending != 0 || got.CreditsPending != 0 ||
		got.DebitsPosted != 0 || got.CreditsPosted != 0 {
		t.Errorf("CreatePayableAccount() account counters are not zero: %+v", got)
	}
}

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

	if second.Account.ID != first.Account.ID {
		t.Errorf(
			"retry CreatePayableAccount() Account.ID = %d, want %d",
			second.Account.ID,
			first.Account.ID,
		)
	}
	if second.Account.Reference != first.Account.Reference {
		t.Errorf(
			"retry CreatePayableAccount() Account.Reference = %q, want %q",
			second.Account.Reference,
			first.Account.Reference,
		)
	}
	if first.Account.HolderID == nil {
		t.Fatal("first CreatePayableAccount() Account.HolderID = nil, want generated ID")
	}
	if second.Account.HolderID == nil {
		t.Fatal("retry CreatePayableAccount() Account.HolderID = nil, want generated ID")
	}
	if *second.Account.HolderID != *first.Account.HolderID {
		t.Errorf(
			"retry CreatePayableAccount() Account.HolderID = %d, want %d",
			*second.Account.HolderID,
			*first.Account.HolderID,
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

func TestStore_CreatePayableAccount_SameHolderAcrossLedgers(t *testing.T) {
	tx := newTestTx(t)
	ngnLedgerID := seedLedger(t, tx, "ngn_ng", "NGN")
	usdLedgerID := seedLedger(t, tx, "usd_ng", "USD")
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
	if ngnResult.Account.LedgerID != ngnLedgerID {
		t.Errorf(
			"NGN CreatePayableAccount() Account.LedgerID = %d, want %d",
			ngnResult.Account.LedgerID,
			ngnLedgerID,
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
	if usdResult.Account.LedgerID != usdLedgerID {
		t.Errorf(
			"USD CreatePayableAccount() Account.LedgerID = %d, want %d",
			usdResult.Account.LedgerID,
			usdLedgerID,
		)
	}

	if usdResult.Account.ID == ngnResult.Account.ID {
		t.Errorf(
			"accounts share ID %d, want different accounts for different ledgers",
			usdResult.Account.ID,
		)
	}
	if usdResult.Account.Reference == ngnResult.Account.Reference {
		t.Errorf(
			"accounts share reference %q, want different references for different ledgers",
			usdResult.Account.Reference,
		)
	}
	if ngnResult.Account.HolderID == nil {
		t.Fatal("NGN CreatePayableAccount() Account.HolderID = nil, want generated ID")
	}
	if usdResult.Account.HolderID == nil {
		t.Fatal("USD CreatePayableAccount() Account.HolderID = nil, want generated ID")
	}
	if *usdResult.Account.HolderID != *ngnResult.Account.HolderID {
		t.Errorf(
			"USD CreatePayableAccount() Account.HolderID = %d, want %d",
			*usdResult.Account.HolderID,
			*ngnResult.Account.HolderID,
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

func seedLedger(t *testing.T, tx *sql.Tx, slug, currency string) int {
	t.Helper()

	const query = `
		INSERT INTO ledgers (slug, currency, scale)
		VALUES ($1, $2, $3)
		RETURNING id`

	var id int
	if err := tx.QueryRowContext(t.Context(), query, slug, currency, 2).Scan(&id); err != nil {
		t.Fatalf("seed ledger %q: %v", slug, err)
	}

	return id
}
