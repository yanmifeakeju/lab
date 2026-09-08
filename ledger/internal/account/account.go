package account

import "time"

type AccountKind string

const (
	AccountKindPayable    AccountKind = "payable"
	AccountKindCash       AccountKind = "cash"
	AccountKindFeeRevenue AccountKind = "fee_revenue"
)

type Account struct {
	ID                         int64
	Reference                  string
	LedgerID                   int
	Kind                       AccountKind
	HolderID                   *int64
	HolderReference            string
	HolderName                 string
	Description                *string
	DebitsPending              int64
	CreditsPending             int64
	DebitsPosted               int64
	CreditsPosted              int64
	DebitsMustNotExceedCredits bool
	CreditsMustNotExceedDebits bool
	IsClosed                   bool
	CreatedAt                  time.Time
}

type CreatePayableInput struct {
	LedgerSlug string
	ExternalID string
	Name       string
}

type CreateResult struct {
	Account Account
	Created bool
}
