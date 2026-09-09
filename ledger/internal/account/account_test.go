package account_test

import (
	"testing"

	"yanmifeakeju.com/ledger/internal/account"
)

func TestBalanceCounters_Available(t *testing.T) {
	tests := []struct {
		name     string
		kind     account.Kind
		balances account.BalanceCounters
		want     uint64
	}{
		{
			name:     "all zero counters",
			kind:     account.KindPayable,
			balances: account.BalanceCounters{},
			want:     0,
		},
		{
			name: "posted credits only",
			kind: account.KindPayable,
			balances: account.BalanceCounters{
				CreditsPosted: 10000,
			},
			want: 10000,
		},
		{
			name: "credits posted with pending and posted debits",
			kind: account.KindPayable,
			balances: account.BalanceCounters{
				DebitsPending: 200,
				DebitsPosted:  100,
				CreditsPosted: 10000,
			},
			want: 9700,
		},
		{
			name: "pending credits do not increase availability",
			kind: account.KindPayable,
			balances: account.BalanceCounters{
				CreditsPending: 5000,
				CreditsPosted:  10000,
				DebitsPending:  200,
			},
			want: 9800,
		},
		{
			name: "debits equal credits",
			kind: account.KindPayable,
			balances: account.BalanceCounters{
				CreditsPosted: 1000,
				DebitsPosted:  800,
				DebitsPending: 200,
			},
			want: 0,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := tt.balances.Available(tt.kind)
			if got != tt.want {
				t.Errorf("BalanceCounters.Available(%q) = %d, want %d", tt.kind, got, tt.want)
			}
		})
	}

	t.Run("payable account panics when debits exceed credits", func(t *testing.T) {
		defer func() {
			r := recover()
			if r == nil {
				t.Fatal("BalanceCounters.Available(KindPayable) did not panic for negative balance")
			}
		}()

		b := account.BalanceCounters{
			CreditsPosted: 500,
			DebitsPosted:  600,
		}
		_ = b.Available(account.KindPayable)
	})

	t.Run("panics for unsupported kind", func(t *testing.T) {
		defer func() {
			r := recover()
			if r == nil {
				t.Fatal("BalanceCounters.Available(KindCash) did not panic")
			}
		}()

		b := account.BalanceCounters{
			CreditsPosted: 1000,
		}
		_ = b.Available(account.KindCash)
	})
}
