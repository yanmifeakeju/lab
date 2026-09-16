package journal

import (
	"time"
)

type Kind string

type State string

const (
	StatePending  State = "pending"
	StatePosted   State = "posted"
	StateCaptured State = "captured"
	StateVoided   State = "voided"
	StateExpired  State = "expired"
)

type Entry struct {
	ID             int64
	RequestID      string
	Reference      string
	LedgerID       int
	Kind           Kind
	State          State
	Description    string
	ExpiresAt      *time.Time
	PendingEntryID *int64
	EffectiveAt    time.Time
	CreatedAt      time.Time
}

type Effect string

const (
	EffectPending       Effect = "pending"
	EffectPosted        Effect = "posted"
	EffectPendingPosted Effect = "pending_posted"
	EffectPendingVoided Effect = "pending_voided"
)

type Line struct {
	ID              int64
	EntryID         int64
	LedgerID        int
	Amount          int64
	DebitAccountID  int64
	CreditAccountID int64
	LineNumber      int
	Effect          Effect
	Purpose         string
}

type LineInput struct {
	DebitAccountReference  string
	CreditAccountReference string
	Amount                 int64
	Purpose                string
}

type PostInput struct {
	LedgerSlug  string
	RequestID   string
	Kind        Kind
	Description string
	EffectiveAt *time.Time
	Lines       []LineInput
}

type PostResult struct {
	Entry   Entry
	Created bool
}
