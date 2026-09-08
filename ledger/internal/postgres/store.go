package postgres

import (
	"context"
	"database/sql"
)

// DBTX is satisfied by *sql.DB and *sql.Tx.
type DBTX interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// Store runs SQL routines against the ledger database.
type Store struct {
	db DBTX
}

// New returns a Store backed by the given DBTX.
func New(db DBTX) *Store {
	return &Store{db: db}
}
