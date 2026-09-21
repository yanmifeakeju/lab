// Package journal defines the core domain types and operations for recording
// financial journal entries in the ledger.
package journal

import (
	"time"
)

// State represents the lifecycle status of a journal entry.
type State string

const (
	// StatePosted indicates an entry whose financial movements are committed and reflected in posted balances.
	StatePosted State = "posted"
	// StatePending indicates a two-phase entry that holds funds pending capture or expiration.
	StatePending State = "pending"
	// StateCaptured indicates a pending entry that was subsequently captured.
	StateCaptured State = "captured"
	// StateVoided indicates a pending entry that was canceled before completion.
	StateVoided State = "voided"
	// StateExpired indicates a pending entry whose authorization window elapsed without capture.
	StateExpired State = "expired"
)

// Entry represents an immutable journal entry recorded in the ledger.
type Entry struct {
	// RequestID is the client-provided idempotency key for the entry.
	RequestID string
	// Reference is the public ULID identifier for the entry (e.g. jrn_...).
	Reference string
	// Kind is the client-defined classification describing the business type of the entry.
	Kind string
	// State is the current lifecycle state of the entry.
	State State
	// Description provides a human-readable explanation of why the entry occurred.
	Description string
	// ExpiresAt is the timestamp after which a pending entry is considered expired.
	// It is nil for one-phase posted entries.
	ExpiresAt *time.Time
	// EffectiveAt is the business date and time at which the financial effect applies, if provided.
	// Otherwise, it equals the posting time.
	EffectiveAt time.Time
	// CreatedAt is the database timestamp recording when the entry was created.
	CreatedAt time.Time
}

// LineInput describes a single balanced leg within a proposed journal entry.
// It transfers Amount from DebitAccountReference to CreditAccountReference.
type LineInput struct {
	DebitAccountReference  string
	CreditAccountReference string
	Amount                 int64
	Purpose                string
}

// PostInput contains the parameters required to post a new journal entry.
type PostInput struct {
	LedgerSlug  string
	RequestID   string
	Kind        string
	Description string
	EffectiveAt *time.Time
	Lines       []LineInput
}

// PostResult contains the outcome of a posting operation.
type PostResult struct {
	// Entry is the recorded or matched idempotent journal entry.
	Entry Entry
	// Created is true if a new entry was created, or false if an existing entry
	// was returned due to an idempotent retry.
	Created bool
}
