package journal

import (
	"errors"
	"fmt"
)

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

	// ErrBatchTooSmall is returned when a batch contains fewer entries than the
	// minimum that makes batching worthwhile.
	ErrBatchTooSmall = errors.New("batch too small")

	// ErrBatchSizeExceeded is returned when a batch contains more entries than the maximum allowed.
	ErrBatchSizeExceeded = errors.New("batch size exceeded")

	// ErrTooManyLines is returned when an entry has more than MaxEntryLines lines.
	ErrTooManyLines = errors.New("too many lines")

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

	// ErrEntryNotFound is returned when a resolution names no entry in the
	// ledger.
	ErrEntryNotFound = errors.New("entry not found")

	// ErrEntryNotPending is returned when a resolution names an entry that was
	// posted immediately.
	ErrEntryNotPending = errors.New("entry not pending")

	// ErrEntryResolved is returned when the pending entry was already
	// resolved. The error is a *ResolvedError naming the winner.
	ErrEntryResolved = errors.New("entry resolved")

	// ErrDuplicatePendingReference is returned when a batch names one pending
	// entry twice.
	ErrDuplicatePendingReference = errors.New("duplicate pending reference")
)

// ResolvedError reports the resolution that won a pending entry.
type ResolvedError struct {
	// PendingState is the state the winning resolution left.
	PendingState        State
	ResolutionReference string
}

func (e *ResolvedError) Error() string {
	return fmt.Sprintf("%s: %s by %s", ErrEntryResolved, e.PendingState, e.ResolutionReference)
}

func (e *ResolvedError) Is(target error) bool { return target == ErrEntryResolved }
