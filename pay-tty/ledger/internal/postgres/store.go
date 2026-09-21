package postgres

import (
	"context"
	"database/sql"
	"time"

	"yanmifeakeju.com/ledger/internal/statement"
)

// DBTX is satisfied by *sql.DB and *sql.Tx.
type DBTX interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}

// Store runs SQL routines against the ledger database.
type Store struct {
	db              DBTX
	statementMargin time.Duration
}

// New returns a Store backed by the given DBTX.
func New(db DBTX) *Store {
	return &Store{db: db, statementMargin: statement.Margin}
}

// timePtr converts a nullable timestamp column to the domain's optional time.
func timePtr(t sql.NullTime) *time.Time {
	if !t.Valid {
		return nil
	}
	return &t.Time
}
