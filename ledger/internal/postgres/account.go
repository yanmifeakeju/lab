package postgres

import (
	"context"
	"database/sql"
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

func (s *Store) GetPayableAccount(ctx context.Context, input account.GetPayableAccountInput) (account.GetPayableAccountResult, error) {
	const q = `
	SELECT
		a.public_ref,
		a.kind,
		a.debits_pending,
		a.credits_pending,
		a.debits_posted,
		a.credits_posted,
		a.is_closed,
		a.created_at,
		l.slug,
		h.public_ref
	FROM ledgers l
	LEFT JOIN accounts a
		ON a.ledger_id = l.id
		AND a.public_ref = $2
		AND a.kind = 'payable'
	LEFT JOIN holders h
		ON a.holder_id = h.id
	WHERE l.slug = $1;`

	row := s.db.QueryRowContext(ctx, q, input.LedgerSlug, input.Reference)

	var (
		accountRef     sql.NullString
		kind           sql.NullString
		debitsPending  sql.NullInt64
		creditsPending sql.NullInt64
		debitsPosted   sql.NullInt64
		creditsPosted  sql.NullInt64
		isClosed       sql.NullBool
		createdAt      sql.NullTime
		ledgerSlug     string
		holderRef      sql.NullString
	)

	if err := row.Scan(
		&accountRef,
		&kind,
		&debitsPending,
		&creditsPending,
		&debitsPosted,
		&creditsPosted,
		&isClosed,
		&createdAt,
		&ledgerSlug,
		&holderRef,
	); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return account.GetPayableAccountResult{}, fmt.Errorf("get payable account: %w", account.ErrLedgerNotFound)
		}

		return account.GetPayableAccountResult{}, fmt.Errorf("get payable account: %w", err)
	}

	if !accountRef.Valid {
		return account.GetPayableAccountResult{}, fmt.Errorf("get payable account: %w", account.ErrAccountNotFound)
	}

	return account.GetPayableAccountResult{
		Reference:  accountRef.String,
		HolderRef:  holderRef.String,
		Kind:       account.Kind(kind.String),
		LedgerSlug: ledgerSlug,
		IsClosed:   isClosed.Bool,
		Balances: account.BalanceCounters{
			DebitsPending:  debitsPending.Int64,
			CreditsPending: creditsPending.Int64,
			DebitsPosted:   debitsPosted.Int64,
			CreditsPosted:  creditsPosted.Int64,
		},
		CreatedAt: createdAt.Time,
	}, nil
}
