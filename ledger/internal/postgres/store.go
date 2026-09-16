package postgres

import (
	"context"
	"database/sql"
	"time"
)

// DBTX is satisfied by *sql.DB and *sql.Tx.
type DBTX interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}

// Store runs SQL routines against the ledger database.
type Store struct {
	db DBTX
}

// New returns a Store backed by the given DBTX.
func New(db DBTX) *Store {
	return &Store{db: db}
}

// timePtr converts a nullable timestamp column to the domain's optional time.
func timePtr(t sql.NullTime) *time.Time {
	if !t.Valid {
		return nil
	}
	return &t.Time
}
