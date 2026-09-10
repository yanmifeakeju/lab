package account

import (
	"fmt"
	"time"
)

// Kind represents the classification of a ledger account.
type Kind string

const (
	// KindPayable identifies an account belonging to an external entity or merchant.
	KindPayable Kind = "payable"
	// KindCash identifies the internal platform cash account.
	KindCash Kind = "cash"
	// KindFeeRevenue identifies the internal platform fee revenue account.
	KindFeeRevenue Kind = "fee_revenue"
)

// Account represents a ledger account and its associated holder details.
type Account struct {
	ID                         int64
	Reference                  string
	LedgerID                   int
	Kind                       Kind
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

// CreatePayableInput contains the parameters required to onboard a payable account.
type CreatePayableInput struct {
	LedgerSlug string
	ExternalID string
	Name       string
}

// CreateResult is the result of onboarding a payable account.
type CreateResult struct {
	Account Payable
	Created bool
}

// GetPayableInput contains the query parameters for looking up a payable account.
type GetPayableInput struct {
	LedgerSlug string
	Reference  string
}

// BalanceCounters represents the persisted debit and credit counters for an account.
type BalanceCounters struct {
	DebitsPending  int64
	CreditsPending int64
	DebitsPosted   int64
	CreditsPosted  int64
}

// Available computes the derived spendable balance for an account kind.
// For payable accounts: available = credits_posted - debits_posted - debits_pending.
// Pending credits do not increase availability until captured or posted.
// Panics if kind is payable and available balance is negative.
// TODO: Return a signed balance and allow negative API values if payable
// accounts are permitted to go negative for chargebacks in the future.
func (b BalanceCounters) Available(kind Kind) uint64 {
	switch kind {
	case KindPayable:
		avail := b.CreditsPosted - b.DebitsPosted - b.DebitsPending
		if avail < 0 {
			panic(fmt.Sprintf("payable account available balance cannot be negative: %d", avail))
		}
		return uint64(avail)
	default:
		panic(fmt.Sprintf("unsupported account kind for available balance: %s", kind))
	}
}

// Payable represents a merchant payable account exposed by account operations.
type Payable struct {
	Reference       string
	HolderReference string
	HolderName      string
	LedgerSlug      string
	IsClosed        bool
	Balances        BalanceCounters
	CreatedAt       time.Time
}

// Available returns the payable account's derived spendable balance.
func (p Payable) Available() uint64 {
	return p.Balances.Available(KindPayable)
}
