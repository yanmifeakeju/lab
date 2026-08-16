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
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}

// Store runs SQL routines against the ledger database. Methods are safe to
// call concurrently; transactions are managed via [Store.WithinTx].
type Store struct {
	db DBTX
}

// New returns a Store backed by the given DBTX.
func New(db DBTX) *Store {
	return &Store{db: db}
}

// WithinTx runs fn against a transaction-scoped Store. If fn returns nil the
// transaction commits; if it returns an error the transaction rolls back.
// Calling WithinTx on a Store that is already backed by a *sql.Tx is an
// error — nested calls would silently open a second transaction and run
// half the work outside the outer unit.
func (s *Store) WithinTx(ctx context.Context, fn func(*Store) error) error {
	if _, ok := s.db.(*sql.Tx); ok {
		return errors.New("store: already in a transaction")
	}

	db, ok := s.db.(*sql.DB)
	if !ok {
		return fmt.Errorf("store: backing DBTX is %T, want *sql.DB", s.db)
	}

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}

	txStore := &Store{db: tx}
	if err := fn(txStore); err != nil {
		if rbErr := tx.Rollback(); rbErr != nil {
			return errors.Join(err, fmt.Errorf("rollback: %w", rbErr))
		}
		return err
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit: %w", err)
	}
	return nil
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
