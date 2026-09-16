// Package statement defines the account-statement read model.
package statement

import (
	"time"
)

// Direction describes how a movement changes a payable account's balance.
type Direction string

const (
	// DirectionDebit decreases the account's balance.
	DirectionDebit Direction = "debit"
	// DirectionCredit increases the account's balance.
	DirectionCredit Direction = "credit"
)

// Navigation identifies the direction of cursor-based pagination.
type Navigation string

const (
	// NavigationNext requests movements after the cursor position.
	NavigationNext Navigation = "next"
	// NavigationPrevious requests movements before the cursor position.
	NavigationPrevious Navigation = "previous"
)

// ListInput contains the parameters for listing a payable account's statement.
type ListInput struct {
	AccountReference string
	From             time.Time
	To               time.Time
	Limit            int
	Cursor           *Cursor
}

// Account identifies the payable account represented by a statement.
type Account struct {
	Reference       string
	HolderReference string
	Name            string
}

// Period is the half-open recorded-time range covered by a statement.
type Period struct {
	From time.Time
	To   time.Time
}

// Movement represents one journal line affecting the payable account.
type Movement struct {
	JournalReference string
	LineNumber       int
	Kind             string
	Direction        Direction
	Amount           int64
	BalanceAfter     int64
	Description      string
	Purpose          string
	RecordedAt       time.Time
}

// Page describes the available movement pages around the current page.
type Page struct {
	Limit    int
	Previous *Cursor
	Next     *Cursor
}

// Result is a payable account statement and its pagination positions.
type Result struct {
	Account        Account
	Period         Period
	OpeningBalance int64
	ClosingBalance int64
	Movements      []Movement
	Page           Page
}
