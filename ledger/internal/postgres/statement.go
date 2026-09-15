package postgres

import (
	"context"
	"database/sql"
	"fmt"
	"slices"
	"time"

	"yanmifeakeju.com/ledger/internal/account"
	"yanmifeakeju.com/ledger/internal/journal"
	"yanmifeakeju.com/ledger/internal/statement"
)

const statementBaseQuery = `
WITH target_account AS (
	SELECT
		a.id,
		a.ledger_id,
		a.public_ref,
		h.public_ref AS holder_ref,
		h.name AS holder_name
	FROM accounts a
	LEFT JOIN holders h
		ON a.holder_id = h.id
	WHERE a.public_ref = $1
		AND a.kind = 'payable'
),
account_lines AS (
	SELECT line.journal_entry_id, line.line_number, 'debit'::text AS direction, line.amount, -line.amount AS signed_amount
	FROM target_account target
	JOIN journal_lines line ON line.debit_account_id = target.id AND line.ledger_id = target.ledger_id AND line.effect = 'posted'
	UNION ALL
	SELECT line.journal_entry_id, line.line_number, 'credit'::text AS direction, line.amount, line.amount AS signed_amount
	FROM target_account target
	JOIN journal_lines line ON line.credit_account_id = target.id AND line.ledger_id = target.ledger_id AND line.effect = 'posted'
),
all_movements AS (
	SELECT
		entry.public_ref AS journal_reference,
		line.line_number,
		entry.kind,
		entry.description,
		entry.created_at AS recorded_at,
		line.direction,
		line.amount,
		line.signed_amount
	FROM account_lines line
	JOIN target_account target ON true
	JOIN journal_entries entry ON entry.id = line.journal_entry_id AND entry.ledger_id = target.ledger_id
),
balances AS (
	SELECT
		coalesce(sum(CASE WHEN m.recorded_at < $2 THEN m.signed_amount ELSE 0 END), 0)::bigint AS opening_balance,
		coalesce(sum(CASE WHEN m.recorded_at < $3 THEN m.signed_amount ELSE 0 END), 0)::bigint AS closing_balance
	FROM target_account target
	LEFT JOIN all_movements m ON true
),
period_movements AS (
	SELECT m.*
	FROM all_movements m
	WHERE m.recorded_at >= $2 AND m.recorded_at < $3
),
sequenced AS (
	SELECT
		m.journal_reference,
		m.line_number,
		m.kind,
		m.direction,
		m.amount,
		m.description,
		m.recorded_at,
		(
			b.opening_balance
			+ sum(m.signed_amount) OVER (
				ORDER BY m.recorded_at ASC, m.journal_reference ASC, m.line_number ASC
				ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
			)
		)::bigint AS balance_after
	FROM period_movements m
	CROSS JOIN balances b
)`

const statementPreviousSuffix = `,
page_movements AS (
	SELECT s.*
	FROM sequenced s
	WHERE (s.recorded_at, s.journal_reference, s.line_number) < ($4, $5, $6)
	ORDER BY s.recorded_at DESC, s.journal_reference DESC, s.line_number DESC
	LIMIT $7
)
SELECT
	target.public_ref,
	target.holder_ref,
	target.holder_name,
	b.opening_balance,
	b.closing_balance,
	p.journal_reference,
	p.line_number,
	p.kind,
	p.direction,
	p.amount,
	p.balance_after,
	p.description,
	p.recorded_at
FROM target_account target
CROSS JOIN balances b
LEFT JOIN page_movements p ON true
ORDER BY p.recorded_at DESC, p.journal_reference DESC, p.line_number DESC;`

const statementNextSuffix = `,
page_movements AS (
	SELECT s.*
	FROM sequenced s
	WHERE ($4::boolean IS FALSE OR (s.recorded_at, s.journal_reference, s.line_number) > ($5, $6, $7))
	ORDER BY s.recorded_at ASC, s.journal_reference ASC, s.line_number ASC
	LIMIT $8
)
SELECT
	target.public_ref,
	target.holder_ref,
	target.holder_name,
	b.opening_balance,
	b.closing_balance,
	p.journal_reference,
	p.line_number,
	p.kind,
	p.direction,
	p.amount,
	p.balance_after,
	p.description,
	p.recorded_at
FROM target_account target
CROSS JOIN balances b
LEFT JOIN page_movements p ON true
ORDER BY p.recorded_at ASC, p.journal_reference ASC, p.line_number ASC;`

// GetStatement retrieves a payable account's statement and its pagination positions.
// Balances and movements are evaluated in a single statement snapshot.
func (s *Store) GetStatement(
	ctx context.Context,
	input statement.ListInput,
) (statement.Result, error) {
	isPrevious := input.Cursor != nil && input.Cursor.Navigation == statement.NavigationPrevious

	var query string
	var args []any

	if isPrevious {
		query = statementBaseQuery + statementPreviousSuffix
		args = []any{
			input.AccountReference,
			input.From,
			input.To,
			input.Cursor.Position.RecordedAt,
			input.Cursor.Position.JournalReference,
			input.Cursor.Position.LineNumber,
			input.Limit + 1,
		}
	} else {
		query = statementBaseQuery + statementNextSuffix
		hasCursor := input.Cursor != nil && input.Cursor.Navigation == statement.NavigationNext
		cursorRec := time.Time{}
		var cursorRef string
		var cursorLineNumber int
		if hasCursor {
			cursorRec = input.Cursor.Position.RecordedAt
			cursorRef = input.Cursor.Position.JournalReference
			cursorLineNumber = input.Cursor.Position.LineNumber
		}

		args = []any{
			input.AccountReference,
			input.From,
			input.To,
			hasCursor,
			cursorRec,
			cursorRef,
			cursorLineNumber,
			input.Limit + 1,
		}
	}

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return statement.Result{}, fmt.Errorf("query statement: %w", err)
	}
	defer rows.Close()

	var (
		accountRef     sql.NullString
		holderRef      sql.NullString
		holderName     sql.NullString
		openingBalance int64
		closingBalance int64
		fetched        []statement.Movement
	)

	for rows.Next() {
		var (
			jref         sql.NullString
			lineNum      sql.NullInt64
			kind         sql.NullString
			dir          sql.NullString
			amount       sql.NullInt64
			balanceAfter sql.NullInt64
			desc         sql.NullString
			recAt        sql.NullTime
		)

		if err := rows.Scan(
			&accountRef,
			&holderRef,
			&holderName,
			&openingBalance,
			&closingBalance,
			&jref,
			&lineNum,
			&kind,
			&dir,
			&amount,
			&balanceAfter,
			&desc,
			&recAt,
		); err != nil {
			return statement.Result{}, fmt.Errorf("scan statement movement: %w", err)
		}

		if jref.Valid {
			var d *string
			if desc.Valid {
				d = &desc.String
			}
			fetched = append(fetched, statement.Movement{
				JournalReference: jref.String,
				LineNumber:       int(lineNum.Int64),
				Kind:             journal.Kind(kind.String),
				Direction:        statement.Direction(dir.String),
				Amount:           amount.Int64,
				BalanceAfter:     balanceAfter.Int64,
				Description:      d,
				RecordedAt:       recAt.Time,
			})
		}
	}
	if err := rows.Err(); err != nil {
		return statement.Result{}, fmt.Errorf("iterate statement movements: %w", err)
	}

	if !accountRef.Valid {
		return statement.Result{}, fmt.Errorf("get statement: %w", account.ErrAccountNotFound)
	}

	result := statement.Result{
		Account: statement.Account{
			Reference:       accountRef.String,
			HolderReference: holderRef.String,
			Name:            holderName.String,
		},
		Period: statement.Period{
			From: input.From,
			To:   input.To,
		},
		OpeningBalance: openingBalance,
		ClosingBalance: closingBalance,
		Movements:      make([]statement.Movement, 0),
		Page: statement.Page{
			Limit: input.Limit,
		},
	}

	// Handle pagination boundaries and cursor creation.
	if isPrevious {
		hasPrevious := len(fetched) > input.Limit
		if hasPrevious {
			fetched = fetched[:input.Limit]
		}
		// Rows were retrieved DESC, reverse back to chronological order (ASC).
		slices.Reverse(fetched)

		hasNext := true // Arrived via previous navigation, so next page exists.

		if hasPrevious && len(fetched) > 0 {
			result.Page.Previous = &statement.Cursor{
				Navigation: statement.NavigationPrevious,
				Position: statement.Position{
					RecordedAt:       fetched[0].RecordedAt,
					JournalReference: fetched[0].JournalReference,
					LineNumber:       fetched[0].LineNumber,
				},
			}
		}
		if hasNext && len(fetched) > 0 {
			result.Page.Next = &statement.Cursor{
				Navigation: statement.NavigationNext,
				Position: statement.Position{
					RecordedAt:       fetched[len(fetched)-1].RecordedAt,
					JournalReference: fetched[len(fetched)-1].JournalReference,
					LineNumber:       fetched[len(fetched)-1].LineNumber,
				},
			}
		}
	} else {
		hasNext := len(fetched) > input.Limit
		if hasNext {
			fetched = fetched[:input.Limit]
		}
		hasPrevious := input.Cursor != nil // If forward with cursor, a previous page exists.

		if hasPrevious && len(fetched) > 0 {
			result.Page.Previous = &statement.Cursor{
				Navigation: statement.NavigationPrevious,
				Position: statement.Position{
					RecordedAt:       fetched[0].RecordedAt,
					JournalReference: fetched[0].JournalReference,
					LineNumber:       fetched[0].LineNumber,
				},
			}
		}
		if hasNext && len(fetched) > 0 {
			result.Page.Next = &statement.Cursor{
				Navigation: statement.NavigationNext,
				Position: statement.Position{
					RecordedAt:       fetched[len(fetched)-1].RecordedAt,
					JournalReference: fetched[len(fetched)-1].JournalReference,
					LineNumber:       fetched[len(fetched)-1].LineNumber,
				},
			}
		}
	}

	result.Movements = fetched
	if result.Movements == nil {
		result.Movements = make([]statement.Movement, 0)
	}

	return result, nil
}
