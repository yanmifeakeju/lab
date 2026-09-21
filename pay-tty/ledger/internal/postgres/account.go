package postgres

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/oklog/ulid/v2"

	"yanmifeakeju.com/ledger/internal/account"
)

// accountRow is an accounts row joined with its holder, whose columns are
// NULL for platform accounts.
type accountRow struct {
	ID                         int64
	Reference                  string
	LedgerID                   int
	Kind                       string
	HolderID                   sql.NullInt64
	HolderReference            sql.NullString
	HolderName                 sql.NullString
	Label                      sql.NullString
	Description                sql.NullString
	DebitsPending              int64
	CreditsPending             int64
	DebitsPosted               int64
	CreditsPosted              int64
	DebitsMustNotExceedCredits bool
	CreditsMustNotExceedDebits bool
	RecordsMovements           bool
	ClosedAt                   sql.NullTime
	CreatedAt                  time.Time
}

// scanTargets returns the row's fields in create_payable_account's column
// order.
func (r *accountRow) scanTargets() []any {
	return []any{
		&r.ID, &r.Reference, &r.LedgerID, &r.Kind, &r.HolderID,
		&r.HolderReference, &r.HolderName, &r.Label, &r.Description,
		&r.DebitsPending, &r.CreditsPending, &r.DebitsPosted, &r.CreditsPosted,
		&r.DebitsMustNotExceedCredits, &r.CreditsMustNotExceedDebits,
		&r.RecordsMovements, &r.ClosedAt, &r.CreatedAt,
	}
}

func (r accountRow) payable(ledgerSlug string) account.Payable {
	return account.Payable{
		Reference:       r.Reference,
		HolderReference: r.HolderReference.String,
		HolderName:      r.HolderName.String,
		LedgerSlug:      ledgerSlug,
		ClosedAt:        timePtr(r.ClosedAt),
		Balances: account.BalanceCounters{
			DebitsPending:  r.DebitsPending,
			CreditsPending: r.CreditsPending,
			DebitsPosted:   r.DebitsPosted,
			CreditsPosted:  r.CreditsPosted,
		},
		CreatedAt: r.CreatedAt,
	}
}

// CreatePayableAccount creates a merchant's payable account, or returns the
// existing account when the request is an idempotent retry.
func (s *Store) CreatePayableAccount(
	ctx context.Context,
	input account.CreatePayableInput,
) (account.CreateResult, error) {
	var (
		row     accountRow
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
	).Scan(append(row.scanTargets(), &created)...)
	if err != nil {
		return account.CreateResult{}, mapCreatePayableAccountError(err)
	}
	return account.CreateResult{
		Account: row.payable(input.LedgerSlug),
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

func (s *Store) GetPayableAccount(ctx context.Context, input account.GetPayableInput) (account.Payable, error) {
	const q = `
	SELECT
		a.public_ref,
		a.debits_pending,
		a.credits_pending,
		a.debits_posted,
		a.credits_posted,
		a.closed_at,
		a.created_at,
		l.slug,
		h.public_ref,
		h.name
	FROM accounts a
	JOIN ledgers l ON l.id = a.ledger_id
	JOIN holders h ON h.id = a.holder_id
	WHERE a.public_ref = $1
		AND a.kind = 'payable';`

	var (
		p        account.Payable
		closedAt sql.NullTime
	)
	err := s.db.QueryRowContext(ctx, q, input.Reference).Scan(
		&p.Reference,
		&p.Balances.DebitsPending,
		&p.Balances.CreditsPending,
		&p.Balances.DebitsPosted,
		&p.Balances.CreditsPosted,
		&closedAt,
		&p.CreatedAt,
		&p.LedgerSlug,
		&p.HolderReference,
		&p.HolderName,
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return account.Payable{}, fmt.Errorf("get payable account: %w", account.ErrAccountNotFound)
		}

		return account.Payable{}, fmt.Errorf("get payable account: %w", err)
	}
	p.ClosedAt = timePtr(closedAt)

	return p, nil
}
