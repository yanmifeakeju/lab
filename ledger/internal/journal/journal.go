package journal

import (
	"time"
)

type State string

const (
	StatePending  State = "pending"
	StatePosted   State = "posted"
	StateCaptured State = "captured"
	StateVoided   State = "voided"
	StateExpired  State = "expired"
)

type Entry struct {
	RequestID   string
	Reference   string
	Kind        string
	State       State
	Description string
	ExpiresAt   *time.Time
	EffectiveAt time.Time
	CreatedAt   time.Time
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
	Kind        string
	Description string
	EffectiveAt *time.Time
	Lines       []LineInput
}

type PostResult struct {
	Entry   Entry
	Created bool
}
