package journal

import "errors"

var (
	// ErrLedgerNotFound is returned when the supplied ledger slug does not exist.
	ErrLedgerNotFound = errors.New("ledger not found")

	// ErrLedgerClosed is returned when the ledger exists but is closed.
	ErrLedgerClosed = errors.New("ledger closed")

	// ErrAccountNotFound is returned when a referenced account does not exist in
	// the supplied ledger.
	ErrAccountNotFound = errors.New("account not found")

	// ErrAccountClosed is returned when an entry references a closed account.
	ErrAccountClosed = errors.New("account closed")

	// ErrInsufficientFunds is returned when posting an entry would violate an
	// account's balance restriction.
	ErrInsufficientFunds = errors.New("insufficient funds")

	// ErrIdempotencyConflict is returned when a request ID is reused with
	// different entry content.
	ErrIdempotencyConflict = errors.New("idempotency conflict")

	// ErrNoLines is returned when a post entry contains no lines.
	ErrNoLines = errors.New("no lines")

	// ErrNoSelfTransfer is returned when a post entry line debits and credits
	// the same account.
	ErrNoSelfTransfer = errors.New("no self transfer")

	// ErrNonPositiveAmount is returned when a post entry line has a zero or
	// negative amount.
	ErrNonPositiveAmount = errors.New("non-positive amount")

	// ErrBlankDescription is returned when an entry description holds no
	// non-whitespace character.
	ErrBlankDescription = errors.New("blank description")

	// ErrDescriptionTooLong is returned when an entry description exceeds the
	// stored length limit.
	ErrDescriptionTooLong = errors.New("description too long")

	// ErrBlankKind is returned when an entry kind holds no non-whitespace
	// character.
	ErrBlankKind = errors.New("blank kind")

	// ErrKindTooLong is returned when an entry kind exceeds the stored length
	// limit.
	ErrKindTooLong = errors.New("kind too long")

	// ErrBlankPurpose is returned when a line purpose holds no non-whitespace
	// character.
	ErrBlankPurpose = errors.New("blank purpose")

	// ErrPurposeTooLong is returned when a line purpose exceeds the stored
	// length limit.
	ErrPurposeTooLong = errors.New("purpose too long")
)
