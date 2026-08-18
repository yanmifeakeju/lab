package postgres

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/lib/pq"
	"yanmifeakeju.com/ledger/internal/account"
)

// DBTX is satisfied by *sql.DB and *sql.Tx.
type DBTX interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// Store runs SQL routines against the ledger database.
type Store struct {
	db DBTX
}

// New returns a Store backed by the given DBTX.
func New(db DBTX) *Store {
	return &Store{db: db}
}

// CreatePayableAccount onboards a merchant's payable account. The SQL
// routine create_payable_account() creates the holder (if missing) and seeds
// their payable account in one atomic step; this method is its Go caller.
// Returns the created account with the holder's name attached.
func (s *Store) CreatePayableAccount(
	ctx context.Context,
	input account.CreatePayableInput,
) (account.CreateResult, error) {
	var (
		a       account.Account
		created bool
	)
	const q = `SELECT * FROM create_payable_account($1, $2, $3)`

	err := s.db.QueryRowContext(ctx, q, input.ExternalID, input.Name, input.LedgerSlug).Scan(
		&a.ID, &a.LedgerID, &a.Kind, &a.Channel, &a.HolderID, &a.HolderName,
		&a.Description,
		&a.DebitsPending, &a.CreditsPending, &a.DebitsPosted, &a.CreditsPosted,
		&a.DebitsMustNotExceedCredits, &a.CreditsMustNotExceedDebits,
		&a.IsClosed, &a.CreatedAt, &created,
	)
	if err != nil {
		return account.CreateResult{}, mapPgError(err)
	}
	return account.CreateResult{
		Account: a,
		Created: created,
	}, nil
}

// mapPgError translates the ERRCODEs raised by the SQL routines into typed
// sentinel errors the caller can branch on with errors.Is. Anything else is
// returned wrapped, preserving the original pq.Error for diagnostics.
func mapPgError(err error) error {
	if pqErr, ok := errors.AsType[*pq.Error](err); ok {
		switch string(pqErr.Code) {
		case "LG001":
			return fmt.Errorf("%w: %s", account.ErrLedgerNotFound, pqErr.Message)
		case "LG002":
			return fmt.Errorf("%w: %s", account.ErrLedgerClosed, pqErr.Message)
		case "LG003":
			return fmt.Errorf("%w: %s", account.ErrHolderConflict, pqErr.Message)
		}
	}
	return fmt.Errorf("create payable account: %w", err)
}
