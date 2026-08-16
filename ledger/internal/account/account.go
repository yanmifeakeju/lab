package account

import "time"

type AccountKind string

const (
	AccountKindPayable    AccountKind = "payable"
	AccountKindReceivable AccountKind = "receivable"
	AccountKindTreasury   AccountKind = "treasury"
	AccountKindFeeRevenue AccountKind = "fee_revenue"
)

type Account struct {
	ID                         int64
	LedgerID                   int
	Kind                       AccountKind
	Channel                    *string
	HolderID                   *int64
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
