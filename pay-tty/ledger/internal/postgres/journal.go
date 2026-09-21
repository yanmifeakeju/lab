package postgres

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/oklog/ulid/v2"

	"yanmifeakeju.com/ledger/internal/journal"
)

// journalEntryRow is a journal_entries row.
type journalEntryRow struct {
	ID             int64
	Reference      string
	LedgerID       int
	RequestID      string
	Kind           string
	State          string
	Description    string
	ExpiresAt      sql.NullTime
	PendingEntryID sql.NullInt64
	EffectiveAt    time.Time
	CreatedAt      time.Time
}

func (r journalEntryRow) entry() journal.Entry {
	return journal.Entry{
		RequestID:   r.RequestID,
		Reference:   r.Reference,
		Kind:        r.Kind,
		State:       journal.State(r.State),
		Description: r.Description,
		ExpiresAt:   timePtr(r.ExpiresAt),
		EffectiveAt: r.EffectiveAt,
		CreatedAt:   r.CreatedAt,
	}
}

type postEntryLine struct {
	DebitAccountReference  string `json:"debit_account_ref"`
	CreditAccountReference string `json:"credit_account_ref"`
	Amount                 int64  `json:"amount"`
	Purpose                string `json:"purpose"`
}

// PostEntry records an immediately posted journal entry, or returns the
// existing entry when the request is an idempotent retry.
func (s *Store) PostEntry(ctx context.Context, input journal.PostInput) (journal.PostResult, error) {
	var (
		row     journalEntryRow
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
			Purpose:                line.Purpose,
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
		&row.ID,
		&row.Reference,
		&row.LedgerID,
		&row.RequestID,
		&row.Kind,
		&row.State,
		&row.Description,
		&row.ExpiresAt,
		&row.PendingEntryID,
		&row.EffectiveAt,
		&row.CreatedAt,
		&created,
	)
	if err != nil {
		return journal.PostResult{}, mapPostEntryError(err)
	}

	return journal.PostResult{Entry: row.entry(), Created: created}, nil
}

type postBatchEntryItem struct {
	PublicRef   string          `json:"public_ref"`
	RequestID   string          `json:"request_id"`
	Kind        string          `json:"kind"`
	Description string          `json:"description"`
	EffectiveAt *time.Time      `json:"effective_at,omitempty"`
	Lines       []postEntryLine `json:"lines"`
}

// PostEntries records a batch of journal entries in a single database transaction.
func (s *Store) PostEntries(ctx context.Context, input journal.BatchInput) (journal.BatchResult, error) {
	const q = `SELECT out_entry_index, out_request_id, out_status, out_error_code, out_error_message, out_public_ref FROM post_entries($1, $2::jsonb)`

	batchItems := make([]postBatchEntryItem, len(input.Entries))
	for i, entry := range input.Entries {
		lines := make([]postEntryLine, len(entry.Lines))
		for j, line := range entry.Lines {
			lines[j] = postEntryLine{
				DebitAccountReference:  line.DebitAccountReference,
				CreditAccountReference: line.CreditAccountReference,
				Amount:                 line.Amount,
				Purpose:                line.Purpose,
			}
		}

		batchItems[i] = postBatchEntryItem{
			PublicRef:   "jrn_" + ulid.Make().String(),
			RequestID:   entry.RequestID,
			Kind:        entry.Kind,
			Description: entry.Description,
			EffectiveAt: entry.EffectiveAt,
			Lines:       lines,
		}
	}

	encodedBatch, err := json.Marshal(batchItems)
	if err != nil {
		return journal.BatchResult{}, fmt.Errorf("marshal post entries batch: %w", err)
	}

	rows, err := s.db.QueryContext(ctx, q, input.LedgerSlug, string(encodedBatch))
	if err != nil {
		return journal.BatchResult{}, mapPostEntryError(err)
	}
	defer rows.Close()

	results := make([]journal.BatchItemResult, 0, len(input.Entries))
	for rows.Next() {
		var (
			entryIndex   int
			requestID    string
			status       string
			errorCode    sql.NullString
			errorMessage sql.NullString
			publicRef    sql.NullString
		)

		if err := rows.Scan(
			&entryIndex,
			&requestID,
			&status,
			&errorCode,
			&errorMessage,
			&publicRef,
		); err != nil {
			return journal.BatchResult{}, fmt.Errorf("scan batch item result: %w", err)
		}

		item := journal.BatchItemResult{
			RequestID: requestID,
			Status:    journal.BatchItemStatus(status),
		}

		if publicRef.Valid && status != string(journal.BatchItemRejected) {
			ref := publicRef.String
			item.JournalRef = &ref
		}

		if status == string(journal.BatchItemRejected) && errorCode.Valid {
			item.Error = &journal.BatchItemError{
				Code:    errorCode.String,
				Message: errorMessage.String,
			}
		}

		results = append(results, item)
	}

	if err := rows.Err(); err != nil {
		return journal.BatchResult{}, mapPostEntryError(err)
	}

	return journal.BatchResult{Results: results}, nil
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
		case "LG025":
			return fmt.Errorf("%w: %s", journal.ErrBatchSizeExceeded, pgErr.Message)
		case "LG027":
			return fmt.Errorf("%w: %s", journal.ErrBatchTooSmall, pgErr.Message)
		case "LG026":
			return fmt.Errorf("%w: %s", journal.ErrBatchLinesExceeded, pgErr.Message)
		case "LG022":
			return fmt.Errorf("%w: %s", journal.ErrAccountNotFound, pgErr.Message)
		case "LG024":
			return fmt.Errorf("%w: %s", journal.ErrInsufficientFunds, pgErr.Message)
		case "23514":
			switch pgErr.ConstraintName {
			// The routines pre-check limits so a breach is normally a domain
			// error already. These two are the safety net for a breach that
			// only becomes true after the check, which a caller should still
			// read as a limit, not as a server fault.
			case "accounts_debits_must_not_exceed_credits",
				"accounts_credits_must_not_exceed_debits":
				return fmt.Errorf("%w: %s", journal.ErrInsufficientFunds, pgErr.Message)
			case "journal_lines_no_self_transfer":
				return fmt.Errorf("%w: %s", journal.ErrNoSelfTransfer, pgErr.Message)
			case "journal_lines_amount_positive":
				return fmt.Errorf("%w: %s", journal.ErrNonPositiveAmount, pgErr.Message)
			case "journal_entries_description_not_blank":
				return fmt.Errorf("%w: %s", journal.ErrBlankDescription, pgErr.Message)
			case "journal_entries_description_length":
				return fmt.Errorf("%w: %s", journal.ErrDescriptionTooLong, pgErr.Message)
			case "journal_entries_kind_not_blank":
				return fmt.Errorf("%w: %s", journal.ErrBlankKind, pgErr.Message)
			case "journal_entries_kind_length":
				return fmt.Errorf("%w: %s", journal.ErrKindTooLong, pgErr.Message)
			case "journal_lines_purpose_not_blank":
				return fmt.Errorf("%w: %s", journal.ErrBlankPurpose, pgErr.Message)
			case "journal_lines_purpose_length":
				return fmt.Errorf("%w: %s", journal.ErrPurposeTooLong, pgErr.Message)
			}
		}
	}
	return fmt.Errorf("post entry: %w", err)
}
