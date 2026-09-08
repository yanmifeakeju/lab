package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/oklog/ulid/v2"

	"yanmifeakeju.com/ledger/internal/journal"
)

type postEntryLine struct {
	DebitAccountReference  string `json:"debit_account_ref"`
	CreditAccountReference string `json:"credit_account_ref"`
	Amount                 int64  `json:"amount"`
}

// PostEntry records an immediately posted journal entry, or returns the
// existing entry when the request is an idempotent retry.
func (s *Store) PostEntry(ctx context.Context, input journal.PostInput) (journal.PostResult, error) {
	var (
		e       journal.Entry
		created bool
	)
	const q = `SELECT * FROM post_entry($1, $2, $3, $4, $5, $6, $7::jsonb)`

	journalReference := "jrn_" + ulid.Make().String()
	entryLines := make([]postEntryLine, len(input.Lines))
	for i, line := range input.Lines {
		entryLines[i] = postEntryLine{
			DebitAccountReference:  line.DebitAccountReference,
			CreditAccountReference: line.CreditAccountReference,
			Amount:                 line.Amount,
		}
	}
	encodedLines, err := json.Marshal(entryLines)
	if err != nil {
		return journal.PostResult{}, fmt.Errorf("marshal post entry lines: %w", err)
	}

	err = s.db.QueryRowContext(
		ctx,
		q,
		journalReference,
		input.LedgerSlug,
		input.RequestID,
		input.Kind,
		input.Description,
		input.EffectiveAt,
		string(encodedLines),
	).Scan(
		&e.ID,
		&e.Reference,
		&e.LedgerID,
		&e.RequestID,
		&e.Kind,
		&e.State,
		&e.Description,
		&e.ExpiresAt,
		&e.PendingEntryID,
		&e.EffectiveAt,
		&e.CreatedAt,
		&created,
	)

	if err != nil {
		return journal.PostResult{}, mapPostEntryError(err)
	}

	return journal.PostResult{Entry: e, Created: created}, nil
}

func mapPostEntryError(err error) error {
	if pgErr, ok := errors.AsType[*pgconn.PgError](err); ok {
		switch pgErr.Code {
		case "LG001":
			return fmt.Errorf("%w: %s", journal.ErrLedgerNotFound, pgErr.Message)
		case "LG002":
			return fmt.Errorf("%w: %s", journal.ErrLedgerClosed, pgErr.Message)
		case "LG011":
			return fmt.Errorf("%w: %s", journal.ErrAccountClosed, pgErr.Message)
		case "LG020":
			return fmt.Errorf("%w: %s", journal.ErrIdempotencyConflict, pgErr.Message)
		case "LG021":
			return fmt.Errorf("%w: %s", journal.ErrNoLines, pgErr.Message)
		case "LG022":
			return fmt.Errorf("%w: %s", journal.ErrAccountNotFound, pgErr.Message)
		case "LG024":
			return fmt.Errorf("%w: %s", journal.ErrInsufficientFunds, pgErr.Message)
		case "23514":
			switch pgErr.ConstraintName {
			case "journal_lines_no_self_transfer":
				return fmt.Errorf("%w: %s", journal.ErrNoSelfTransfer, pgErr.Message)
			case "journal_lines_amount_positive":
				return fmt.Errorf("%w: %s", journal.ErrNonPositiveAmount, pgErr.Message)
			}
		}
	}
	return fmt.Errorf("post entry: %w", err)
}
