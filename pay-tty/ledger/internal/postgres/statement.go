package postgres

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"slices"
	"time"

	"yanmifeakeju.com/ledger/internal/account"
	"yanmifeakeju.com/ledger/internal/statement"
)

const statementAccountQuery = `
SELECT a.id, a.public_ref, h.public_ref, h.name
FROM accounts a
JOIN holders h ON h.id = a.holder_id
WHERE a.public_ref = $1
	AND a.kind = 'payable'`

// The statement query takes the account id as a value, not a join column, so
// a custom plan estimates the movement lookups from that account's own
// statistics; planned as an average account, a large one sits near the point
// where a bitmap scan and a sort over the whole period win.
//
// Each lookup is LATERAL so it walks account_movements_account_recorded_idx in
// order and stops at its LIMIT, and journal_entries is joined after the page
// is cut.
//
// period is resolved against the database clock, the clock that stamps
// recorded_at. It is NOT MATERIALIZED so the planner sees the bound
// expressions rather than an opaque CTE row. statement_timestamp() is stable, which keeps them
// index conditions; unlike now(), it also follows postings made earlier in the
// caller's transaction.
const statementHead = `
WITH period AS NOT MATERIALIZED (
	SELECT
		coalesce($2::timestamptz, bound.period_to - make_interval(secs => $5::double precision)) AS period_from,
		bound.period_to
	FROM (
		SELECT least(
			coalesce($3::timestamptz, statement_timestamp() - make_interval(secs => $4::double precision)),
			statement_timestamp() - make_interval(secs => $4::double precision)
		) AS period_to
	) bound
)
SELECT
	period.period_from,
	period.period_to,
	coalesce(opening.balance_after, 0)::bigint,
	coalesce(closing.balance_after, 0)::bigint,
	page.sequence,
	entry.public_ref,
	page.line_number,
	entry.kind,
	page.direction,
	page.amount,
	page.balance_after,
	entry.description,
	page.purpose,
	page.recorded_at
FROM period
LEFT JOIN LATERAL (
	SELECT m.balance_after
	FROM account_movements m
	WHERE m.account_id = $1
		AND m.recorded_at < period.period_from
	ORDER BY m.recorded_at DESC, m.sequence DESC
	LIMIT 1
) opening ON true
LEFT JOIN LATERAL (
	SELECT m.balance_after
	FROM account_movements m
	WHERE m.account_id = $1
		AND m.recorded_at < period.period_to
	ORDER BY m.recorded_at DESC, m.sequence DESC
	LIMIT 1
) closing ON true`

// The page's near bound is one row comparison merging the cursor with the
// period edge; (period_from, 0) matches recorded_at >= period_from because
// sequences start at 1. As separate conditions they give a generic plan an
// estimate below the LIMIT.
const statementNextPage = `
LEFT JOIN LATERAL (
	SELECT m.sequence, m.journal_entry_id, m.line_number, m.direction, m.amount,
		m.balance_after, m.purpose, m.recorded_at
	FROM account_movements m
	WHERE m.account_id = $1
		AND (m.recorded_at, m.sequence) > (
			greatest($6::timestamptz, period.period_from),
			CASE WHEN $6::timestamptz >= period.period_from THEN $7::bigint ELSE 0 END
		)
		AND m.recorded_at < period.period_to
	ORDER BY m.recorded_at ASC, m.sequence ASC
	LIMIT $8
) page ON true
LEFT JOIN journal_entries entry ON entry.id = page.journal_entry_id
ORDER BY page.recorded_at ASC, page.sequence ASC`

const statementPreviousPage = `
LEFT JOIN LATERAL (
	SELECT m.sequence, m.journal_entry_id, m.line_number, m.direction, m.amount,
		m.balance_after, m.purpose, m.recorded_at
	FROM account_movements m
	WHERE m.account_id = $1
		AND (m.recorded_at, m.sequence) < (
			least($6::timestamptz, period.period_to),
			CASE WHEN $6::timestamptz < period.period_to THEN $7::bigint ELSE 0 END
		)
		AND m.recorded_at >= period.period_from
	ORDER BY m.recorded_at DESC, m.sequence DESC
	LIMIT $8
) page ON true
LEFT JOIN journal_entries entry ON entry.id = page.journal_entry_id
ORDER BY page.recorded_at DESC, page.sequence DESC`

// GetStatement retrieves a payable account's statement and its pagination positions.
// A missing account is reported before an invalid period. Balances and
// movements are evaluated in a single statement snapshot.
func (s *Store) GetStatement(
	ctx context.Context,
	input statement.ListInput,
) (statement.Result, error) {
	var (
		accountID int64
		acct      statement.Account
	)
	err := s.db.QueryRowContext(ctx, statementAccountQuery, input.AccountReference).
		Scan(&accountID, &acct.Reference, &acct.HolderReference, &acct.Name)
	if errors.Is(err, sql.ErrNoRows) {
		return statement.Result{}, fmt.Errorf("get statement: %w", account.ErrAccountNotFound)
	}
	if err != nil {
		return statement.Result{}, fmt.Errorf("query statement account: %w", err)
	}

	isPrevious := input.Cursor != nil && input.Cursor.Navigation == statement.NavigationPrevious
	query := statementHead + statementNextPage
	if isPrevious {
		query = statementHead + statementPreviousPage
	}

	var cursorRecordedAt *time.Time
	var cursorSequence *int64
	if input.Cursor != nil {
		cursorRecordedAt = &input.Cursor.Position.RecordedAt
		cursorSequence = &input.Cursor.Position.Sequence
	}

	rows, err := s.db.QueryContext(ctx, query,
		accountID,
		input.From,
		input.To,
		s.statementMargin.Seconds(),
		statement.DefaultPeriod.Seconds(),
		cursorRecordedAt,
		cursorSequence,
		input.Limit+1,
	)
	if err != nil {
		return statement.Result{}, fmt.Errorf("query statement: %w", err)
	}
	defer rows.Close()

	var (
		period         statement.Period
		openingBalance int64
		closingBalance int64
		fetched        []statement.Movement
	)

	for rows.Next() {
		var (
			seq          sql.NullInt64
			jref         sql.NullString
			lineNum      sql.NullInt64
			kind         sql.NullString
			dir          sql.NullString
			amount       sql.NullInt64
			balanceAfter sql.NullInt64
			desc         sql.NullString
			purpose      sql.NullString
			recAt        sql.NullTime
		)

		if err := rows.Scan(
			&period.From,
			&period.To,
			&openingBalance,
			&closingBalance,
			&seq,
			&jref,
			&lineNum,
			&kind,
			&dir,
			&amount,
			&balanceAfter,
			&desc,
			&purpose,
			&recAt,
		); err != nil {
			return statement.Result{}, fmt.Errorf("scan statement movement: %w", err)
		}

		if jref.Valid {
			fetched = append(fetched, statement.Movement{
				Sequence:         seq.Int64,
				JournalReference: jref.String,
				LineNumber:       int(lineNum.Int64),
				Kind:             kind.String,
				Direction:        statement.Direction(dir.String),
				Amount:           amount.Int64,
				BalanceAfter:     balanceAfter.Int64,
				Description:      desc.String,
				Purpose:          purpose.String,
				RecordedAt:       recAt.Time,
			})
		}
	}
	if err := rows.Err(); err != nil {
		return statement.Result{}, fmt.Errorf("iterate statement movements: %w", err)
	}

	if !period.From.Before(period.To) {
		return statement.Result{}, fmt.Errorf("get statement: %w", statement.ErrPeriodNotOrdered)
	}
	if period.To.Sub(period.From) > statement.MaxPeriod {
		return statement.Result{}, fmt.Errorf("get statement: %w", statement.ErrPeriodTooLong)
	}

	result := statement.Result{
		Account:        acct,
		Period:         period,
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
					RecordedAt: fetched[0].RecordedAt,
					Sequence:   fetched[0].Sequence,
				},
			}
		}
		if hasNext && len(fetched) > 0 {
			result.Page.Next = &statement.Cursor{
				Navigation: statement.NavigationNext,
				Position: statement.Position{
					RecordedAt: fetched[len(fetched)-1].RecordedAt,
					Sequence:   fetched[len(fetched)-1].Sequence,
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
					RecordedAt: fetched[0].RecordedAt,
					Sequence:   fetched[0].Sequence,
				},
			}
		}
		if hasNext && len(fetched) > 0 {
			result.Page.Next = &statement.Cursor{
				Navigation: statement.NavigationNext,
				Position: statement.Position{
					RecordedAt: fetched[len(fetched)-1].RecordedAt,
					Sequence:   fetched[len(fetched)-1].Sequence,
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
