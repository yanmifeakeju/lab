// Package journal defines the core domain types and operations for recording
// financial journal entries in the ledger.
package journal

import (
	"time"
)

// State represents the lifecycle status of a journal entry. An entry posted
// immediately is always posted; a pending entry takes its authorization's
// state.
type State string

const (
	StatePosted   State = "posted"
	StatePending  State = "pending"
	StateCaptured State = "captured"
	StateVoided   State = "voided"
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
	Pending     bool
}

// PostResult contains the outcome of a posting operation.
type PostResult struct {
	// Entry is the recorded or matched idempotent journal entry.
	Entry Entry
	// Created is true if a new entry was created, or false if an existing entry
	// was returned due to an idempotent retry.
	Created bool
}

// BatchItemStatus represents the outcome status of an entry within a batch.
type BatchItemStatus string

const (
	BatchItemCreated  BatchItemStatus = "created"
	BatchItemExisting BatchItemStatus = "existing"
	BatchItemRejected BatchItemStatus = "rejected"
)

// BatchItemError represents an individual entry's domain rejection reason.
type BatchItemError struct {
	Code    string
	Message string
}

// BatchItemInput describes an individual journal entry within a batch posting.
type BatchItemInput struct {
	RequestID   string
	Kind        string
	Description string
	EffectiveAt *time.Time
	Lines       []LineInput
	Pending     bool
}

// Batch limits enforced across single batch postings.
//
// MinBatchEntries exists because setting up a batch costs about what ten
// single postings cost: below it, PostEntry is the faster route for the same
// entries, so a smaller batch is rejected rather than served slowly.
const (
	MinBatchEntries = 10
	MaxBatchEntries = 1000
	MaxBatchLines   = 5000
)

// BatchInput contains the parameters required to post a batch of journal entries.
type BatchInput struct {
	LedgerSlug string
	Entries    []BatchItemInput
}

// BatchItemResult contains the outcome for one entry in a posted batch. State
// is set unless the entry was rejected.
type BatchItemResult struct {
	RequestID  string
	Status     BatchItemStatus
	JournalRef *string
	State      State
	Error      *BatchItemError
}

// BatchResult contains the results for all entries in a batch posting.
type BatchResult struct {
	Results []BatchItemResult
}

// Action is how a resolution settles a pending entry.
type Action string

const (
	ActionCapture Action = "capture"
	ActionVoid    Action = "void"
)

// ResolveInput asks for one pending entry to be captured or voided.
type ResolveInput struct {
	LedgerSlug       string
	RequestID        string
	PendingReference string
	Action           Action
	EffectiveAt      *time.Time
}

// Resolution is a posted entry that settled a pending one. It copies the
// pending entry's kind, description and lines.
type Resolution struct {
	Reference        string
	RequestID        string
	Kind             string
	Description      string
	EffectiveAt      time.Time
	CreatedAt        time.Time
	PendingReference string
	// State is the pending entry's state after this resolution.
	State State
}

// ResolveResult contains the outcome of a resolution.
type ResolveResult struct {
	Resolution Resolution
	// Created is false when an identical request was already resolved.
	Created bool
}

// ResolveBatchItemInput describes one resolution within a batch.
type ResolveBatchItemInput struct {
	RequestID        string
	PendingReference string
	Action           Action
	EffectiveAt      *time.Time
}

// ResolveBatchInput contains the parameters required to resolve a batch.
type ResolveBatchInput struct {
	LedgerSlug string
	Items      []ResolveBatchItemInput
}

// ResolveBatchItemResult contains the outcome for one item in a batch.
type ResolveBatchItemResult struct {
	RequestID        string
	PendingReference string
	Status           BatchItemStatus
	// JournalRef is this item's resolution; nil when rejected.
	JournalRef *string
	// State is the pending entry's state: after this resolution, or the one
	// that won when the item was rejected as entry_resolved.
	State *State
	// ResolvedBy is the winning resolution of an entry_resolved rejection.
	ResolvedBy *string
	Error      *BatchItemError
}

// ResolveBatchResult contains the results for all items in a batch.
type ResolveBatchResult struct {
	Results []ResolveBatchItemResult
}
