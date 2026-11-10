package postgres

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"

	"github.com/oklog/ulid/v2"

	"paytty.akeju.me/ledger/internal/journal"
)

// ResolveEntry captures or voids a pending entry, or returns the existing
// resolution when the request is an idempotent retry.
func (s *Store) ResolveEntry(ctx context.Context, input journal.ResolveInput) (journal.ResolveResult, error) {
	const q = `SELECT * FROM resolve_entry($1, $2, $3, $4, $5)`

	var (
		r       journal.Resolution
		state   string
		created bool
	)
	err := s.db.QueryRowContext(
		ctx,
		q,
		"jrn_"+ulid.Make().String(),
		input.LedgerSlug,
		input.RequestID,
		input.PendingReference,
		string(input.Action),
	).Scan(
		&r.Reference,
		&r.RequestID,
		&r.Kind,
		&r.Description,
		&r.CreatedAt,
		&r.PendingReference,
		&state,
		&created,
	)
	if err != nil {
		return journal.ResolveResult{}, mapPostEntryError(err)
	}
	r.PendingState = journal.State(state)

	return journal.ResolveResult{Resolution: r, Created: created}, nil
}

type resolveBatchItem struct {
	PublicRef  string `json:"public_ref"`
	RequestID  string `json:"request_id"`
	PendingRef string `json:"pending_ref"`
	Action     string `json:"action"`
}

// ResolveEntries resolves a batch of pending entries in one database
// transaction, with an outcome per item.
func (s *Store) ResolveEntries(ctx context.Context, input journal.ResolveBatchInput) (journal.ResolveBatchResult, error) {
	const q = `SELECT out_request_id, out_status, out_error_code, out_error_message, out_public_ref, out_pending_ref, out_state, out_resolved_by FROM resolve_entries($1, $2::jsonb)`

	items := make([]resolveBatchItem, len(input.Items))
	for i, item := range input.Items {
		items[i] = resolveBatchItem{
			PublicRef:  "jrn_" + ulid.Make().String(),
			RequestID:  item.RequestID,
			PendingRef: item.PendingReference,
			Action:     string(item.Action),
		}
	}
	encoded, err := json.Marshal(items)
	if err != nil {
		return journal.ResolveBatchResult{}, fmt.Errorf("marshal resolve entries batch: %w", err)
	}

	rows, err := s.db.QueryContext(ctx, q, input.LedgerSlug, string(encoded))
	if err != nil {
		return journal.ResolveBatchResult{}, mapPostEntryError(err)
	}
	defer rows.Close()

	results := make([]journal.ResolveBatchItemResult, 0, len(input.Items))
	for rows.Next() {
		var (
			item         journal.ResolveBatchItemResult
			status       string
			errorCode    sql.NullString
			errorMessage sql.NullString
			publicRef    sql.NullString
			state        sql.NullString
			resolvedBy   sql.NullString
		)
		if err := rows.Scan(
			&item.RequestID,
			&status,
			&errorCode,
			&errorMessage,
			&publicRef,
			&item.PendingReference,
			&state,
			&resolvedBy,
		); err != nil {
			return journal.ResolveBatchResult{}, fmt.Errorf("scan resolve batch item result: %w", err)
		}

		item.Status = journal.BatchItemStatus(status)
		if publicRef.Valid {
			item.JournalRef = &publicRef.String
		}
		if state.Valid {
			st := journal.State(state.String)
			item.PendingState = &st
		}
		if resolvedBy.Valid {
			item.ResolvedBy = &resolvedBy.String
		}
		if errorCode.Valid {
			item.Error = &journal.BatchItemError{Code: errorCode.String, Message: errorMessage.String}
		}
		results = append(results, item)
	}
	if err := rows.Err(); err != nil {
		return journal.ResolveBatchResult{}, mapPostEntryError(err)
	}

	return journal.ResolveBatchResult{Results: results}, nil
}
