package postgres

import "time"

// NewWithStatementMargin returns a Store whose statements end margin before
// the database clock, so tests can read postings they have just made.
func NewWithStatementMargin(db DBTX, margin time.Duration) *Store {
	return &Store{db: db, statementMargin: margin}
}
