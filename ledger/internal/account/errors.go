package account

import "errors"

var (
	// ErrLedgerNotFound is returned when the supplied ledger slug does not exist.
	ErrLedgerNotFound = errors.New("ledger not found")

	// ErrLedgerClosed is returned when the ledger exists but is closed.
	ErrLedgerClosed = errors.New("ledger closed")

	// ErrHolderConflict is returned when a holder with the same external id
	// already exists under a different name.
	ErrHolderConflict = errors.New("holder conflict")

	// ErrAccountNotFound is returned when an account cannot be retrieved
	ErrAccountNotFound = errors.New("account not found")
)
