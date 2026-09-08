package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/oklog/ulid/v2"

	"yanmifeakeju.com/ledger/internal/account"
)

// CreatePayableAccount creates a merchant's payable account, or returns the
// existing account when the request is an idempotent retry.
func (s *Store) CreatePayableAccount(
	ctx context.Context,
	input account.CreatePayableInput,
) (account.CreateResult, error) {
	var (
		a       account.Account
		created bool
	)
	holderReference := "hld_" + ulid.Make().String()
	accountReference := "acct_" + ulid.Make().String()
	const q = `SELECT * FROM create_payable_account($1, $2, $3, $4, $5)`

	err := s.db.QueryRowContext(
		ctx,
		q,
		input.ExternalID,
		input.Name,
		input.LedgerSlug,
		holderReference,
		accountReference,
	).Scan(
		&a.ID, &a.Reference, &a.LedgerID, &a.Kind, &a.HolderID,
		&a.HolderReference, &a.HolderName, &a.Description,
		&a.DebitsPending, &a.CreditsPending, &a.DebitsPosted, &a.CreditsPosted,
		&a.DebitsMustNotExceedCredits, &a.CreditsMustNotExceedDebits,
		&a.IsClosed, &a.CreatedAt, &created,
	)
	if err != nil {
		return account.CreateResult{}, mapCreatePayableAccountError(err)
	}
	return account.CreateResult{
		Account: a,
		Created: created,
	}, nil
}

func mapCreatePayableAccountError(err error) error {
	if pgErr, ok := errors.AsType[*pgconn.PgError](err); ok {
		switch pgErr.Code {
		case "LG001":
			return fmt.Errorf("%w: %s", account.ErrLedgerNotFound, pgErr.Message)
		case "LG002":
			return fmt.Errorf("%w: %s", account.ErrLedgerClosed, pgErr.Message)
		case "LG003":
			return fmt.Errorf("%w: %s", account.ErrHolderConflict, pgErr.Message)
		}
	}
	return fmt.Errorf("create payable account: %w", err)
}
