package httpapi_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"yanmifeakeju.com/ledger/internal/account"
	"yanmifeakeju.com/ledger/internal/api"
	"yanmifeakeju.com/ledger/internal/httpapi"
	"yanmifeakeju.com/ledger/internal/journal"
	"yanmifeakeju.com/ledger/internal/statement"
)

type fakeService struct {
	input           account.CreatePayableInput
	result          account.CreateResult
	err             error
	calls           int
	postInput       journal.PostInput
	postResult      journal.PostResult
	postErr         error
	postCalls       int
	getInput        account.GetPayableInput
	getResult       account.Payable
	getErr          error
	getCalls        int
	statementInput  statement.ListInput
	statementResult statement.Result
	statementErr    error
	statementCalls  int
}

func (f *fakeService) CreatePayableAccount(
	_ context.Context,
	input account.CreatePayableInput,
) (account.CreateResult, error) {
	f.input = input
	f.calls++
	return f.result, f.err
}

func (f *fakeService) GetPayableAccount(
	_ context.Context,
	input account.GetPayableInput,
) (account.Payable, error) {
	f.getInput = input
	f.getCalls++
	return f.getResult, f.getErr
}

func (f *fakeService) PostEntry(
	_ context.Context,
	input journal.PostInput,
) (journal.PostResult, error) {
	f.postInput = input
	f.postCalls++
	return f.postResult, f.postErr
}

func (f *fakeService) GetStatement(
	_ context.Context,
	input statement.ListInput,
) (statement.Result, error) {
	f.statementInput = input
	f.statementCalls++
	return f.statementResult, f.statementErr
}

func TestRoutes(t *testing.T) {
	f := &fakeService{}
	server, err := httpapi.NewHandler(f)
	if err != nil {
		t.Fatalf("Routes: %v", err)
	}

	tests := []struct {
		name       string
		method     string
		target     string
		wantStatus int
	}{
		{name: "health", method: http.MethodGet, target: "/health", wantStatus: http.StatusOK},
		{name: "wrong method", method: http.MethodPost, target: "/health", wantStatus: http.StatusMethodNotAllowed},
		{name: "unknown route", method: http.MethodGet, target: "/nope", wantStatus: http.StatusNotFound},
		{name: "old create account route returns 404", method: http.MethodPost, target: "/ledgers/ngn_ng/accounts", wantStatus: http.StatusNotFound},
		{name: "old get account route returns 404", method: http.MethodGet, target: "/ledgers/ngn_ng/accounts/acct_01K33YV8M82N9MXP4E7J6B1QWK", wantStatus: http.StatusNotFound},
		{name: "old get statement route returns 404", method: http.MethodGet, target: "/ledgers/ngn_ng/accounts/acct_01K33YV8M82N9MXP4E7J6B1QWK/statement", wantStatus: http.StatusNotFound},
		{name: "old post entry route returns 404", method: http.MethodPost, target: "/ledgers/ngn_ng/entries", wantStatus: http.StatusNotFound},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(tt.method, tt.target, nil)
			rec := httptest.NewRecorder()

			server.ServeHTTP(rec, req)

			if rec.Code != tt.wantStatus {
				t.Errorf("status = %d, want %d; body = %s", rec.Code, tt.wantStatus, rec.Body.String())
			}
		})
	}
}

func TestCreatePayableAccountValidation(t *testing.T) {
	tests := []struct {
		name        string
		target      string
		body        string
		wantDetails []api.ValidationErrorDetail
		wantStatus  int
	}{
		{
			name:       "valid request is created",
			target:     "/accounts",
			body:       `{"ledger":"ngn_ng","external_id":"merchant_1","name":"Acme Ltd"}`,
			wantStatus: http.StatusCreated,
		},
		{
			name:   "missing ledger",
			target: "/accounts",
			body:   `{"external_id":"merchant_1","name":"Acme Ltd"}`,
			wantDetails: []api.ValidationErrorDetail{
				{Location: api.Body, Field: "ledger", Code: api.Required},
			},
			wantStatus: http.StatusBadRequest,
		},
		{
			name:   "all missing required fields",
			target: "/accounts",
			body:   `{}`,
			wantDetails: []api.ValidationErrorDetail{
				{Location: api.Body, Field: "external_id", Code: api.Required},
				{Location: api.Body, Field: "ledger", Code: api.Required},
				{Location: api.Body, Field: "name", Code: api.Required},
			},
			wantStatus: http.StatusBadRequest,
		},
		{
			name:   "non-string ledger",
			target: "/accounts",
			body:   `{"ledger":123,"external_id":"merchant_1","name":"Acme Ltd"}`,
			wantDetails: []api.ValidationErrorDetail{
				{
					Location: api.Body,
					Field:    "ledger",
					Code:     api.InvalidType,
					Message:  "ledger must be a string",
				},
			},
			wantStatus: http.StatusBadRequest,
		},
		{
			name:   "external ID has wrong type",
			target: "/accounts",
			body:   `{"ledger":"ngn_ng","external_id":2222222,"name":"Acme Ltd"}`,
			wantDetails: []api.ValidationErrorDetail{
				{
					Location: api.Body,
					Field:    "external_id",
					Code:     api.InvalidType,
					Message:  "external_id must be a string",
				},
			},
			wantStatus: http.StatusBadRequest,
		},
		{
			name:   "whitespace-only name",
			target: "/accounts",
			body:   `{"ledger":"ngn_ng","external_id":"merchant_1","name":"   "}`,
			wantDetails: []api.ValidationErrorDetail{
				{Location: api.Body, Field: "name", Code: api.InvalidFormat, Message: "name must not be blank"},
			},
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "unknown fields are ignored",
			target:     "/accounts",
			body:       `{"ledger":"ngn_ng","external_id":"merchant_1","name":"Acme Ltd","another":true,"extra":true}`,
			wantStatus: http.StatusCreated,
		},
		{
			name:   "invalid ledger slug shape",
			target: "/accounts",
			body:   `{"ledger":"bad__slug","external_id":"merchant_1","name":"Acme Ltd"}`,
			wantDetails: []api.ValidationErrorDetail{
				{
					Location: api.Body,
					Field:    "ledger",
					Code:     api.InvalidFormat,
					Message:  "ledger must contain lowercase letters and numbers separated by single underscores",
				},
			},
			wantStatus: http.StatusBadRequest,
		},
		{
			name:   "ledger slug too short",
			target: "/accounts",
			body:   `{"ledger":"ab","external_id":"merchant_1","name":"Acme Ltd"}`,
			wantDetails: []api.ValidationErrorDetail{
				{
					Location: api.Body,
					Field:    "ledger",
					Code:     api.MinLength,
					Message:  "ledger must contain at least 3 characters",
				},
			},
			wantStatus: http.StatusBadRequest,
		},
		{
			name:   "malformed JSON",
			target: "/accounts",
			body:   `{"external_id":`,
			wantDetails: []api.ValidationErrorDetail{
				{Location: api.Body, Field: "body", Code: api.InvalidFormat},
			},
			wantStatus: http.StatusBadRequest,
		},
	}

	handler, err := httpapi.NewHandler(&fakeService{
		result: account.CreateResult{
			Created: true,
			Account: account.Payable{
				Reference:       "acct_01K33YV8M82N9MXP4E7J6B1QWK",
				HolderReference: "hld_01K33YVADP5Z8B0T3X2Q91C6RH",
				HolderName:      "Acme Ltd",
				CreatedAt:       time.Now(),
			},
		},
	})
	if err != nil {
		t.Fatalf("NewHandler: %v", err)
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, tt.target, strings.NewReader(tt.body))
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()

			handler.ServeHTTP(rec, req)

			if rec.Code != tt.wantStatus {
				t.Fatalf("status = %d, want %d; body = %s", rec.Code, tt.wantStatus, rec.Body.String())
			}
			if tt.wantStatus != http.StatusBadRequest {
				return
			}

			var got api.ValidationErrorResponse
			if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
				t.Fatalf("decode response: %v", err)
			}
			if got.Error.Code != api.ValidationErrorCodeValidationError {
				t.Errorf("error code = %q", got.Error.Code)
			}
			if len(got.Error.Details) != len(tt.wantDetails) {
				t.Fatalf("details = %+v, want %+v", got.Error.Details, tt.wantDetails)
			}
			for i, want := range tt.wantDetails {
				detail := got.Error.Details[i]
				if detail.Location != want.Location || detail.Field != want.Field || detail.Code != want.Code {
					t.Errorf("detail[%d] = %+v, want location=%q field=%q code=%q", i, detail, want.Location, want.Field, want.Code)
				}
				if detail.Message == "" {
					t.Errorf("detail[%d] has an empty message", i)
				}
				if want.Message != "" && detail.Message != want.Message {
					t.Errorf("detail[%d] message = %q, want %q", i, detail.Message, want.Message)
				}
			}
		})
	}
}

func TestHealth(t *testing.T) {
	handler, err := httpapi.NewHandler(&fakeService{})
	if err != nil {
		t.Fatalf("Routes: %v", err)
	}
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	var got api.HealthResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if got.Status != "ok" {
		t.Errorf("status body = %q, want ok", got.Status)
	}
}

func TestCreatePayableAccountResponses(t *testing.T) {
	createdAt := time.Date(2026, time.August, 18, 14, 30, 0, 0, time.UTC)
	accountRef := "acct_01K33YV8M82N9MXP4E7J6B1QWK"
	holderRef := "hld_01K33YVADP5Z8B0T3X2Q91C6RH"
	wantInput := account.CreatePayableInput{
		LedgerSlug: "ngn_ng",
		ExternalID: "merchant_1",
		Name:       "Acme Ltd",
	}

	tests := []struct {
		name        string
		result      account.CreateResult
		err         error
		wantStatus  int
		wantCode    api.ErrorCode
		wantMessage string
		wantDetail  *api.ValidationErrorDetail
	}{
		{
			name: "created",
			result: account.CreateResult{
				Created: true,
				Account: account.Payable{
					Reference:       accountRef,
					HolderReference: holderRef,
					HolderName:      "Acme Ltd",
					LedgerSlug:      wantInput.LedgerSlug,
					CreatedAt:       createdAt,
				},
			},
			wantStatus: http.StatusCreated,
		},
		{
			name: "idempotent retry of closed account",
			result: account.CreateResult{
				Created: false,
				Account: account.Payable{
					Reference:       accountRef,
					HolderReference: holderRef,
					HolderName:      "Acme Ltd",
					LedgerSlug:      wantInput.LedgerSlug,
					ClosedAt:        &createdAt,
					Balances: account.BalanceCounters{
						DebitsPending:  200,
						CreditsPending: 500,
						DebitsPosted:   100,
						CreditsPosted:  10000,
					},
					CreatedAt: createdAt,
				},
			},
			wantStatus: http.StatusOK,
		},
		{
			name:       "ledger not found",
			err:        fmt.Errorf("create payable account: %w", account.ErrLedgerNotFound),
			wantStatus: http.StatusBadRequest,
			wantDetail: &api.ValidationErrorDetail{
				Location: api.Body,
				Field:    "ledger",
				Code:     api.InvalidValue,
				Message:  "ledger must name an existing ledger",
			},
		},
		{
			name:        "ledger closed",
			err:         fmt.Errorf("create payable account: %w", account.ErrLedgerClosed),
			wantStatus:  http.StatusConflict,
			wantCode:    api.LedgerClosed,
			wantMessage: "Ledger is closed.",
		},
		{
			name:        "holder conflict",
			err:         fmt.Errorf("create payable account: %w", account.ErrHolderConflict),
			wantStatus:  http.StatusConflict,
			wantCode:    api.HolderConflict,
			wantMessage: "Holder information conflicts with an existing holder.",
		},
		{
			name:        "unexpected error",
			err:         fmt.Errorf("database unavailable"),
			wantStatus:  http.StatusInternalServerError,
			wantCode:    api.InternalServerError,
			wantMessage: "The server could not complete the request.",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			creator := &fakeService{result: tt.result, err: tt.err}
			handler, err := httpapi.NewHandler(creator)
			if err != nil {
				t.Fatalf("NewHandler: %v", err)
			}

			req := httptest.NewRequest(
				http.MethodPost,
				"/accounts",
				strings.NewReader(`{"ledger":"ngn_ng","external_id":"merchant_1","name":"Acme Ltd"}`),
			)
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()

			handler.ServeHTTP(rec, req)

			if rec.Code != tt.wantStatus {
				t.Fatalf("status = %d, want %d; body = %s", rec.Code, tt.wantStatus, rec.Body.String())
			}
			if creator.calls != 1 {
				t.Fatalf("CreatePayableAccount() calls = %d, want 1", creator.calls)
			}
			if creator.input != wantInput {
				t.Errorf("CreatePayableAccount() input = %+v, want %+v", creator.input, wantInput)
			}

			if tt.wantDetail != nil {
				var got api.ValidationErrorResponse
				if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
					t.Fatalf("decode validation response: %v", err)
				}
				if got.Error.Code != api.ValidationErrorCodeValidationError || len(got.Error.Details) != 1 {
					t.Fatalf("validation error = %+v", got.Error)
				}
				if got.Error.Details[0] != *tt.wantDetail {
					t.Errorf("validation detail = %+v, want %+v", got.Error.Details[0], *tt.wantDetail)
				}
				return
			}

			if tt.wantCode == "" {
				var got api.CreatePayableAccountResponse
				if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
					t.Fatalf("decode success response: %v", err)
				}
				if got.LedgerSlug != api.LedgerSlug(wantInput.LedgerSlug) {
					t.Errorf("ledger_slug = %q, want %q", got.LedgerSlug, wantInput.LedgerSlug)
				}
				if got.Reference != accountRef {
					t.Errorf("reference = %q, want %q", got.Reference, accountRef)
				}
				if got.HolderReference != holderRef {
					t.Errorf("holder_reference = %q, want %q", got.HolderReference, holderRef)
				}
				if got.ExternalID != wantInput.ExternalID {
					t.Errorf("external_id = %q, want %q", got.ExternalID, wantInput.ExternalID)
				}
				if got.Name != tt.result.Account.HolderName {
					t.Errorf("name = %q, want %q", got.Name, tt.result.Account.HolderName)
				}
				if got.Kind != api.Payable {
					t.Errorf("kind = %q, want %q", got.Kind, api.Payable)
				}
				wantAccountStatus := api.Active
				if tt.result.Account.ClosedAt != nil && !tt.result.Account.ClosedAt.After(time.Now()) {
					wantAccountStatus = api.Closed
				}
				if got.Status != wantAccountStatus {
					t.Errorf("status = %q, want %q", got.Status, wantAccountStatus)
				}
				if (got.ClosedAt == nil) != (tt.result.Account.ClosedAt == nil) {
					t.Errorf("closed_at = %v, want %v", got.ClosedAt, tt.result.Account.ClosedAt)
				} else if got.ClosedAt != nil && !got.ClosedAt.Equal(*tt.result.Account.ClosedAt) {
					t.Errorf("closed_at = %v, want %v", got.ClosedAt, tt.result.Account.ClosedAt)
				}
				wantBalances := api.AccountBalances{
					DebitsPending:  tt.result.Account.Balances.DebitsPending,
					CreditsPending: tt.result.Account.Balances.CreditsPending,
					DebitsPosted:   tt.result.Account.Balances.DebitsPosted,
					CreditsPosted:  tt.result.Account.Balances.CreditsPosted,
				}
				if got.Balances != wantBalances {
					t.Errorf("balances = %+v, want %+v", got.Balances, wantBalances)
				}
				wantAvailable := int64(tt.result.Account.Available())
				if got.Available != wantAvailable {
					t.Errorf("available = %d, want %d", got.Available, wantAvailable)
				}
				if !got.CreatedAt.Equal(tt.result.Account.CreatedAt) {
					t.Errorf("created_at = %v, want %v", got.CreatedAt, tt.result.Account.CreatedAt)
				}
				return
			}

			var got api.ErrorResponse
			if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
				t.Fatalf("decode error response: %v", err)
			}
			if got.Error.Code != tt.wantCode {
				t.Errorf("error code = %q, want %q", got.Error.Code, tt.wantCode)
			}
			if got.Message != tt.wantMessage {
				t.Errorf("message = %q, want %q", got.Message, tt.wantMessage)
			}
		})
	}
}

func TestCreatePayableAccountTrimsName(t *testing.T) {
	creator := &fakeService{
		result: account.CreateResult{
			Created: true,
			Account: account.Payable{
				Reference:       "acct_01K33YV8M82N9MXP4E7J6B1QWK",
				HolderReference: "hld_01K33YVADP5Z8B0T3X2Q91C6RH",
				HolderName:      "Acme Ltd",
				CreatedAt:       time.Now(),
			},
		},
	}
	handler, err := httpapi.NewHandler(creator)
	if err != nil {
		t.Fatalf("NewHandler: %v", err)
	}

	req := httptest.NewRequest(
		http.MethodPost,
		"/accounts",
		strings.NewReader(`{"ledger":"ngn_ng","external_id":"merchant_1","name":"  Acme Ltd  "}`),
	)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d; body = %s", rec.Code, http.StatusCreated, rec.Body.String())
	}
	if creator.input.Name != "Acme Ltd" {
		t.Errorf("CreatePayableAccount() input name = %q, want %q", creator.input.Name, "Acme Ltd")
	}
}

func TestPostJournalEntryValidation(t *testing.T) {
	const validBody = `{
		"ledger":"ngn_ng",
		"kind":"payment",
		"description":"Payment received",
		"lines":[{
			"debit_account_ref":"acct_cash",
			"credit_account_ref":"acct_payable",
			"amount":10000,
			"purpose":"Card payment"
		}]
	}`

	tests := []struct {
		name        string
		body        string
		key         string
		wantDetails []api.ValidationErrorDetail
	}{
		{
			name: "missing idempotency key",
			body: validBody,
			wantDetails: []api.ValidationErrorDetail{
				{Location: api.Header, Field: "Idempotency-Key", Code: api.Required},
			},
		},
		{
			name: "missing ledger",
			body: `{
				"kind":"payment",
				"description":"Payment received",
				"lines":[{
					"debit_account_ref":"acct_cash",
					"credit_account_ref":"acct_payable",
					"amount":10000,
					"purpose":"Card payment"
				}]
			}`,
			key: "payment_123",
			wantDetails: []api.ValidationErrorDetail{
				{Location: api.Body, Field: "ledger", Code: api.Required},
			},
		},
		{
			name: "missing body fields",
			body: `{}`,
			key:  "payment_123",
			wantDetails: []api.ValidationErrorDetail{
				{Location: api.Body, Field: "description", Code: api.Required},
				{Location: api.Body, Field: "kind", Code: api.Required},
				{Location: api.Body, Field: "ledger", Code: api.Required},
				{Location: api.Body, Field: "lines", Code: api.Required},
			},
		},
		{
			name: "missing description",
			body: `{
				"ledger":"ngn_ng",
				"kind":"payment",
				"lines":[{
					"debit_account_ref":"acct_cash",
					"credit_account_ref":"acct_payable",
					"amount":10000,
					"purpose":"Card payment"
				}]
			}`,
			key: "payment_123",
			wantDetails: []api.ValidationErrorDetail{
				{Location: api.Body, Field: "description", Code: api.Required},
			},
		},
		{
			name: "blank description",
			body: `{
				"ledger":"ngn_ng",
				"kind":"payment",
				"description":"   ",
				"lines":[{
					"debit_account_ref":"acct_cash",
					"credit_account_ref":"acct_payable",
					"amount":10000,
					"purpose":"Card payment"
				}]
			}`,
			key: "payment_123",
			wantDetails: []api.ValidationErrorDetail{
				{
					Location: api.Body,
					Field:    "description",
					Code:     api.InvalidFormat,
					Message:  "description must not be blank",
				},
			},
		},
		{
			name: "missing purpose",
			body: `{
				"ledger":"ngn_ng",
				"kind":"payment",
				"description":"Payment received",
				"lines":[{
					"debit_account_ref":"acct_cash",
					"credit_account_ref":"acct_payable",
					"amount":10000
				}]
			}`,
			key: "payment_123",
			wantDetails: []api.ValidationErrorDetail{
				{Location: api.Body, Field: "lines[0].purpose", Code: api.Required},
			},
		},
		{
			name: "blank purpose",
			body: `{
				"ledger":"ngn_ng",
				"kind":"payment",
				"description":"Payment received",
				"lines":[{
					"debit_account_ref":"acct_cash",
					"credit_account_ref":"acct_payable",
					"amount":10000,
					"purpose":"   "
				}]
			}`,
			key: "payment_123",
			wantDetails: []api.ValidationErrorDetail{
				{
					Location: api.Body,
					Field:    "lines[0].purpose",
					Code:     api.InvalidFormat,
					Message:  "lines[0].purpose must not be blank",
				},
			},
		},
		{
			name: "overlong kind",
			body: fmt.Sprintf(`{
				"ledger":"ngn_ng",
				"kind":"%s",
				"description":"Payment received",
				"lines":[{
					"debit_account_ref":"acct_cash",
					"credit_account_ref":"acct_payable",
					"amount":10000,
					"purpose":"Card payment"
				}]
			}`, strings.Repeat("k", 65)),
			key: "payment_123",
			wantDetails: []api.ValidationErrorDetail{
				{
					Location: api.Body,
					Field:    "kind",
					Code:     api.MaxLength,
					Message:  "kind must not exceed 64 characters",
				},
			},
		},
		{
			name: "empty kind",
			body: `{
				"ledger":"ngn_ng",
				"kind":"",
				"description":"Payment received",
				"lines":[{
					"debit_account_ref":"acct_cash",
					"credit_account_ref":"acct_payable",
					"amount":10000,
					"purpose":"Card payment"
				}]
			}`,
			key: "payment_123",
			wantDetails: []api.ValidationErrorDetail{
				{
					Location: api.Body,
					Field:    "kind",
					Code:     api.InvalidFormat,
					Message:  "kind must not be blank",
				},
				{
					Location: api.Body,
					Field:    "kind",
					Code:     api.MinLength,
					Message:  "kind must not be empty",
				},
			},
		},
		{
			name: "blank kind",
			body: `{
				"ledger":"ngn_ng",
				"kind":"   ",
				"description":"Payment received",
				"lines":[{
					"debit_account_ref":"acct_cash",
					"credit_account_ref":"acct_payable",
					"amount":10000,
					"purpose":"Card payment"
				}]
			}`,
			key: "payment_123",
			wantDetails: []api.ValidationErrorDetail{
				{
					Location: api.Body,
					Field:    "kind",
					Code:     api.InvalidFormat,
					Message:  "kind must not be blank",
				},
			},
		},
		{
			name: "overlong purpose",
			body: fmt.Sprintf(`{
				"ledger":"ngn_ng",
				"kind":"payment",
				"description":"Payment received",
				"lines":[{
					"debit_account_ref":"acct_cash",
					"credit_account_ref":"acct_payable",
					"amount":10000,
					"purpose":"%s"
				}]
			}`, strings.Repeat("p", 101)),
			key: "payment_123",
			wantDetails: []api.ValidationErrorDetail{
				{
					Location: api.Body,
					Field:    "lines[0].purpose",
					Code:     api.MaxLength,
					Message:  "lines[0].purpose must not exceed 100 characters",
				},
			},
		},
		{
			name: "invalid ledger slug shape",
			body: `{
				"ledger":"bad__slug",
				"kind":"payment",
				"description":"Payment received",
				"lines":[{
					"debit_account_ref":"acct_cash",
					"credit_account_ref":"acct_payable",
					"amount":10000,
					"purpose":"Card payment"
				}]
			}`,
			key: "payment_123",
			wantDetails: []api.ValidationErrorDetail{
				{
					Location: api.Body,
					Field:    "ledger",
					Code:     api.InvalidFormat,
					Message:  "ledger must contain lowercase letters and numbers separated by single underscores",
				},
			},
		},
		{
			name: "no lines",
			body: `{"ledger":"ngn_ng","kind":"payment","description":"Payment received","lines":[]}`,
			key:  "payment_123",
			wantDetails: []api.ValidationErrorDetail{
				{Location: api.Body, Field: "lines", Code: api.InvalidValue},
			},
		},
		{
			name: "non-positive amount",
			body: `{
				"ledger":"ngn_ng",
				"kind":"payment",
				"description":"Payment received",
				"lines":[{
					"debit_account_ref":"acct_cash",
					"credit_account_ref":"acct_payable",
					"amount":0,
					"purpose":"Card payment"
				}]
			}`,
			key: "payment_123",
			wantDetails: []api.ValidationErrorDetail{
				{Location: api.Body, Field: "lines[0].amount", Code: api.InvalidValue},
			},
		},
		{
			name: "self transfer",
			body: `{
				"ledger":"ngn_ng",
				"kind":"payment",
				"description":"Payment received",
				"lines":[{
					"debit_account_ref":"acct_same",
					"credit_account_ref":"acct_same",
					"amount":10000,
					"purpose":"Card payment"
				}]
			}`,
			key: "payment_123",
			wantDetails: []api.ValidationErrorDetail{
				{
					Location: api.Body,
					Field:    "lines[0]",
					Code:     api.InvalidValue,
					Message:  "debit_account_ref and credit_account_ref must differ",
				},
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			service := &fakeService{}
			handler, err := httpapi.NewHandler(service)
			if err != nil {
				t.Fatalf("NewHandler: %v", err)
			}

			req := httptest.NewRequest(
				http.MethodPost,
				"/entries",
				strings.NewReader(tt.body),
			)
			req.Header.Set("Content-Type", "application/json")
			if tt.key != "" {
				req.Header.Set("Idempotency-Key", tt.key)
			}
			rec := httptest.NewRecorder()

			handler.ServeHTTP(rec, req)

			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want %d; body = %s", rec.Code, http.StatusBadRequest, rec.Body.String())
			}
			if service.postCalls != 0 {
				t.Errorf("PostEntry() calls = %d, want 0", service.postCalls)
			}

			var got api.ValidationErrorResponse
			if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
				t.Fatalf("decode response: %v", err)
			}
			if len(got.Error.Details) != len(tt.wantDetails) {
				t.Fatalf("details = %+v, want %+v", got.Error.Details, tt.wantDetails)
			}
			for i, want := range tt.wantDetails {
				detail := got.Error.Details[i]
				if detail.Location != want.Location || detail.Field != want.Field || detail.Code != want.Code {
					t.Errorf("detail[%d] = %+v, want location=%q field=%q code=%q", i, detail, want.Location, want.Field, want.Code)
				}
				if detail.Message == "" {
					t.Errorf("detail[%d] has an empty message", i)
				}
				if want.Message != "" && detail.Message != want.Message {
					t.Errorf("detail[%d] message = %q, want %q", i, detail.Message, want.Message)
				}
			}
		})
	}
}

// TestPostJournalEntryAcceptsClientDefinedKind guards the removal of the kind
// enum: the schema bounds a kind's shape, not its vocabulary, so a value the
// ledger has never heard of must reach the service unchanged.
func TestPostJournalEntryAcceptsClientDefinedKind(t *testing.T) {
	kinds := []string{
		"refund",
		"chargeback",
		"payout_reversal",
		strings.Repeat("k", 64),
	}

	for _, kind := range kinds {
		t.Run(kind, func(t *testing.T) {
			service := &fakeService{
				postResult: journal.PostResult{
					Entry: journal.Entry{
						Reference:   "jrn_01K33YW0MDHJ9E4N7Z2QPV6R8K",
						Kind:        kind,
						State:       journal.StatePosted,
						Description: "Payment received",
					},
					Created: true,
				},
			}
			handler, err := httpapi.NewHandler(service)
			if err != nil {
				t.Fatalf("NewHandler: %v", err)
			}

			req := httptest.NewRequest(
				http.MethodPost,
				"/entries",
				strings.NewReader(fmt.Sprintf(`{
					"ledger":"ngn_ng",
					"kind":%q,
					"description":"Payment received",
					"lines":[{
						"debit_account_ref":"acct_cash",
						"credit_account_ref":"acct_payable",
						"amount":10000,
						"purpose":"Card payment"
					}]
				}`, kind)),
			)
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Idempotency-Key", "payment_123")
			rec := httptest.NewRecorder()

			handler.ServeHTTP(rec, req)

			if rec.Code != http.StatusCreated {
				t.Fatalf("status = %d, want %d; body = %s", rec.Code, http.StatusCreated, rec.Body.String())
			}
			if service.postInput.Kind != kind {
				t.Errorf("PostEntry() input kind = %q, want %q", service.postInput.Kind, kind)
			}

			var got api.PostJournalEntryResponse
			if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
				t.Fatalf("decode success response: %v", err)
			}
			if got.Kind != kind {
				t.Errorf("response kind = %q, want %q", got.Kind, kind)
			}
		})
	}
}

func TestPostJournalEntryResponses(t *testing.T) {
	effectiveAt := time.Date(2026, time.September, 8, 10, 30, 0, 0, time.UTC)
	createdAt := effectiveAt.Add(time.Second)
	description := "Payment received"

	wantInput := journal.PostInput{
		LedgerSlug:  "ngn_ng",
		RequestID:   "payment_123",
		Kind:        "payment",
		Description: description,
		EffectiveAt: &effectiveAt,
		Lines: []journal.LineInput{
			{
				DebitAccountReference:  "acct_cash",
				CreditAccountReference: "acct_payable",
				Amount:                 10_000,
				Purpose:                "Card payment",
			},
		},
	}
	postedEntry := journal.Entry{
		Reference:   "jrn_01K33YW0MDHJ9E4N7Z2QPV6R8K",
		Kind:        "payment",
		State:       journal.StatePosted,
		Description: description,
		EffectiveAt: effectiveAt,
		CreatedAt:   createdAt,
	}

	tests := []struct {
		name        string
		result      journal.PostResult
		err         error
		wantStatus  int
		wantCode    api.ErrorCode
		wantMessage string
		wantDetail  *api.ValidationErrorDetail
	}{
		{name: "created", result: journal.PostResult{Entry: postedEntry, Created: true}, wantStatus: http.StatusCreated},
		{name: "idempotent retry", result: journal.PostResult{Entry: postedEntry}, wantStatus: http.StatusOK},
		{
			name:       "ledger not found",
			err:        journal.ErrLedgerNotFound,
			wantStatus: http.StatusBadRequest,
			wantDetail: &api.ValidationErrorDetail{
				Location: api.Body,
				Field:    "ledger",
				Code:     api.InvalidValue,
				Message:  "ledger must name an existing ledger",
			},
		},
		{name: "account not found", err: journal.ErrAccountNotFound, wantStatus: http.StatusNotFound, wantCode: api.AccountNotFound, wantMessage: "Account not found."},
		{name: "ledger closed", err: journal.ErrLedgerClosed, wantStatus: http.StatusConflict, wantCode: api.LedgerClosed, wantMessage: "Ledger is closed."},
		{name: "account closed", err: journal.ErrAccountClosed, wantStatus: http.StatusConflict, wantCode: api.AccountClosed, wantMessage: "Account is closed."},
		{name: "insufficient funds", err: journal.ErrInsufficientFunds, wantStatus: http.StatusConflict, wantCode: api.InsufficientFunds, wantMessage: "Insufficient funds."},
		{name: "idempotency conflict", err: journal.ErrIdempotencyConflict, wantStatus: http.StatusConflict, wantCode: api.IdempotencyConflict, wantMessage: "Idempotency key conflicts with a previous request."},
		{
			name:       "defensive no lines",
			err:        journal.ErrNoLines,
			wantStatus: http.StatusBadRequest,
			wantDetail: &api.ValidationErrorDetail{
				Location: api.Body,
				Field:    "lines",
				Code:     api.InvalidValue,
				Message:  "lines must contain at least one journal line",
			},
		},
		{
			name:       "defensive self transfer",
			err:        journal.ErrNoSelfTransfer,
			wantStatus: http.StatusBadRequest,
			wantDetail: &api.ValidationErrorDetail{
				Location: api.Body,
				Field:    "lines",
				Code:     api.InvalidValue,
				Message:  "debit_account_ref and credit_account_ref must differ",
			},
		},
		{
			name:       "defensive non-positive amount",
			err:        journal.ErrNonPositiveAmount,
			wantStatus: http.StatusBadRequest,
			wantDetail: &api.ValidationErrorDetail{
				Location: api.Body,
				Field:    "lines",
				Code:     api.InvalidValue,
				Message:  "line amounts must be greater than zero",
			},
		},
		{
			name:       "defensive blank description",
			err:        journal.ErrBlankDescription,
			wantStatus: http.StatusBadRequest,
			wantDetail: &api.ValidationErrorDetail{
				Location: api.Body,
				Field:    "description",
				Code:     api.InvalidValue,
				Message:  "description must not be blank",
			},
		},
		{
			name:       "defensive overlong description",
			err:        journal.ErrDescriptionTooLong,
			wantStatus: http.StatusBadRequest,
			wantDetail: &api.ValidationErrorDetail{
				Location: api.Body,
				Field:    "description",
				Code:     api.InvalidValue,
				Message:  "description must not exceed 500 characters",
			},
		},
		{
			name:       "defensive blank kind",
			err:        journal.ErrBlankKind,
			wantStatus: http.StatusBadRequest,
			wantDetail: &api.ValidationErrorDetail{
				Location: api.Body,
				Field:    "kind",
				Code:     api.InvalidValue,
				Message:  "kind must not be blank",
			},
		},
		{
			name:       "defensive overlong kind",
			err:        journal.ErrKindTooLong,
			wantStatus: http.StatusBadRequest,
			wantDetail: &api.ValidationErrorDetail{
				Location: api.Body,
				Field:    "kind",
				Code:     api.InvalidValue,
				Message:  "kind must not exceed 64 characters",
			},
		},
		{
			name:       "defensive blank purpose",
			err:        journal.ErrBlankPurpose,
			wantStatus: http.StatusBadRequest,
			wantDetail: &api.ValidationErrorDetail{
				Location: api.Body,
				Field:    "lines",
				Code:     api.InvalidValue,
				Message:  "line purposes must not be blank",
			},
		},
		{
			name:       "defensive overlong purpose",
			err:        journal.ErrPurposeTooLong,
			wantStatus: http.StatusBadRequest,
			wantDetail: &api.ValidationErrorDetail{
				Location: api.Body,
				Field:    "lines",
				Code:     api.InvalidValue,
				Message:  "line purposes must not exceed 100 characters",
			},
		},
		{name: "unexpected error", err: errors.New("database unavailable"), wantStatus: http.StatusInternalServerError, wantCode: api.InternalServerError, wantMessage: "The server could not complete the request."},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			service := &fakeService{postResult: tt.result, postErr: tt.err}
			handler, err := httpapi.NewHandler(service)
			if err != nil {
				t.Fatalf("NewHandler: %v", err)
			}

			req := httptest.NewRequest(
				http.MethodPost,
				"/entries",
				strings.NewReader(`{
					"ledger":"ngn_ng",
					"kind":"payment",
					"description":"  Payment received  ",
					"effective_at":"2026-09-08T10:30:00Z",
					"lines":[{
						"debit_account_ref":"acct_cash",
						"credit_account_ref":"acct_payable",
						"amount":10000,
						"purpose":"Card payment"
					}]
				}`),
			)
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Idempotency-Key", "payment_123")
			rec := httptest.NewRecorder()

			handler.ServeHTTP(rec, req)

			if rec.Code != tt.wantStatus {
				t.Fatalf("status = %d, want %d; body = %s", rec.Code, tt.wantStatus, rec.Body.String())
			}
			if service.postCalls != 1 {
				t.Fatalf("PostEntry() calls = %d, want 1", service.postCalls)
			}
			if !reflect.DeepEqual(service.postInput, wantInput) {
				t.Errorf("PostEntry() input = %#v, want %#v", service.postInput, wantInput)
			}

			switch {
			case tt.wantDetail != nil:
				var got api.ValidationErrorResponse
				if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
					t.Fatalf("decode validation response: %v", err)
				}
				if got.Error.Code != api.ValidationErrorCodeValidationError || len(got.Error.Details) != 1 {
					t.Fatalf("validation error = %+v", got.Error)
				}
				if got.Error.Details[0] != *tt.wantDetail {
					t.Errorf("validation detail = %+v, want %+v", got.Error.Details[0], *tt.wantDetail)
				}
			case tt.wantCode != "":
				var got api.ErrorResponse
				if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
					t.Fatalf("decode error response: %v", err)
				}
				if got.Error.Code != tt.wantCode {
					t.Errorf("error code = %q, want %q", got.Error.Code, tt.wantCode)
				}
				if got.Message != tt.wantMessage {
					t.Errorf("message = %q, want %q", got.Message, tt.wantMessage)
				}
			default:
				var got api.PostJournalEntryResponse
				if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
					t.Fatalf("decode success response: %v", err)
				}
				if got.JournalRef != postedEntry.Reference {
					t.Errorf("journal_ref = %q, want %q", got.JournalRef, postedEntry.Reference)
				}
				if got.LedgerSlug != "ngn_ng" || got.Kind != "payment" || got.State != api.Posted {
					t.Errorf("response identity = %+v", got)
				}
				if got.Description != description {
					t.Errorf("description = %v, want %q", got.Description, description)
				}
				if !got.EffectiveAt.Equal(effectiveAt) || !got.CreatedAt.Equal(createdAt) {
					t.Errorf("response timestamps = (%v, %v), want (%v, %v)", got.EffectiveAt, got.CreatedAt, effectiveAt, createdAt)
				}
			}
		})
	}
}

func TestGetAccount(t *testing.T) {
	const (
		accountRef = "acct_01K33YV8M82N9MXP4E7J6B1QWK"
		ledgerSlug = "ngn_ng"
	)
	createdAt := time.Date(2026, time.September, 8, 10, 30, 0, 0, time.UTC)
	futureTime := time.Now().Add(24 * time.Hour).Truncate(time.Second)

	tests := []struct {
		name              string
		result            account.Payable
		err               error
		wantStatus        int
		wantCode          api.ErrorCode
		wantMessage       string
		wantAccountStatus api.AccountStatus
	}{
		{
			name: "successful lookup",
			result: account.Payable{
				Reference:       accountRef,
				HolderReference: "hld_01K33YVADP5Z8B0T3X2Q91C6RH",
				HolderName:      "Acme Ltd",
				LedgerSlug:      ledgerSlug,
				Balances: account.BalanceCounters{
					DebitsPending:  200,
					CreditsPending: 0,
					DebitsPosted:   0,
					CreditsPosted:  10000,
				},
				CreatedAt: createdAt,
			},
			wantStatus:        http.StatusOK,
			wantAccountStatus: api.Active,
		},
		{
			name: "closed account",
			result: account.Payable{
				Reference:       accountRef,
				HolderReference: "hld_01K33YVADP5Z8B0T3X2Q91C6RH",
				HolderName:      "Acme Ltd",
				LedgerSlug:      ledgerSlug,
				ClosedAt:        &createdAt,
				Balances: account.BalanceCounters{
					DebitsPending:  200,
					CreditsPending: 0,
					DebitsPosted:   0,
					CreditsPosted:  10000,
				},
				CreatedAt: createdAt,
			},
			wantStatus:        http.StatusOK,
			wantAccountStatus: api.Closed,
		},
		{
			name: "scheduled close in future",
			result: account.Payable{
				Reference:       accountRef,
				HolderReference: "hld_01K33YVADP5Z8B0T3X2Q91C6RH",
				HolderName:      "Acme Ltd",
				LedgerSlug:      ledgerSlug,
				ClosedAt:        &futureTime,
				Balances: account.BalanceCounters{
					DebitsPending:  200,
					CreditsPending: 0,
					DebitsPosted:   0,
					CreditsPosted:  10000,
				},
				CreatedAt: createdAt,
			},
			wantStatus:        http.StatusOK,
			wantAccountStatus: api.Active,
		},
		{
			name:        "account not found",
			err:         fmt.Errorf("get payable account: %w", account.ErrAccountNotFound),
			wantStatus:  http.StatusNotFound,
			wantCode:    api.AccountNotFound,
			wantMessage: "Account not found.",
		},
		{
			name:        "unexpected error",
			err:         errors.New("database connection lost"),
			wantStatus:  http.StatusInternalServerError,
			wantCode:    api.InternalServerError,
			wantMessage: "The server could not complete the request.",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			svc := &fakeService{getResult: tt.result, getErr: tt.err}
			handler, err := httpapi.NewHandler(svc)
			if err != nil {
				t.Fatalf("NewHandler: %v", err)
			}

			req := httptest.NewRequest(
				http.MethodGet,
				fmt.Sprintf("/accounts/%s", accountRef),
				nil,
			)
			rec := httptest.NewRecorder()

			handler.ServeHTTP(rec, req)

			if rec.Code != tt.wantStatus {
				t.Fatalf("status = %d, want %d; body = %s", rec.Code, tt.wantStatus, rec.Body.String())
			}
			if svc.getCalls != 1 {
				t.Fatalf("GetPayableAccount() calls = %d, want 1", svc.getCalls)
			}
			if svc.getInput.Reference != accountRef {
				t.Errorf("GetPayableAccount() Reference = %q, want %q", svc.getInput.Reference, accountRef)
			}

			if tt.wantCode != "" {
				var got api.ErrorResponse
				if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
					t.Fatalf("decode error response: %v", err)
				}
				if got.Error.Code != tt.wantCode {
					t.Errorf("error code = %q, want %q", got.Error.Code, tt.wantCode)
				}
				if got.Message != tt.wantMessage {
					t.Errorf("message = %q, want %q", got.Message, tt.wantMessage)
				}
			} else {
				var got api.GetAccountResponse
				if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
					t.Fatalf("decode success response: %v", err)
				}
				if got.Reference != accountRef {
					t.Errorf("reference = %q, want %q", got.Reference, accountRef)
				}
				if got.HolderReference != tt.result.HolderReference {
					t.Errorf("holder_reference = %q, want %q", got.HolderReference, tt.result.HolderReference)
				}
				if got.LedgerSlug != ledgerSlug {
					t.Errorf("ledger_slug = %q, want %q", got.LedgerSlug, ledgerSlug)
				}
				if got.Kind != api.Payable {
					t.Errorf("kind = %q, want %q", got.Kind, api.Payable)
				}
				if got.Name != tt.result.HolderName {
					t.Errorf("name = %q, want %q", got.Name, tt.result.HolderName)
				}
				if got.Status != tt.wantAccountStatus {
					t.Errorf("status = %q, want %q", got.Status, tt.wantAccountStatus)
				}
				const wantAvailable = int64(9800)
				if got.Available != wantAvailable {
					t.Errorf("available = %d, want %d", got.Available, wantAvailable)
				}
				wantBalances := api.AccountBalances{
					DebitsPending:  200,
					CreditsPending: 0,
					DebitsPosted:   0,
					CreditsPosted:  10000,
				}
				if got.Balances != wantBalances {
					t.Errorf("balances = %+v, want %+v", got.Balances, wantBalances)
				}
				if !got.CreatedAt.Equal(createdAt) {
					t.Errorf("created_at = %v, want %v", got.CreatedAt, createdAt)
				}
				if (got.ClosedAt == nil) != (tt.result.ClosedAt == nil) {
					t.Errorf("closed_at = %v, want %v", got.ClosedAt, tt.result.ClosedAt)
				} else if got.ClosedAt != nil && !got.ClosedAt.Equal(*tt.result.ClosedAt) {
					t.Errorf("closed_at = %v, want %v", got.ClosedAt, tt.result.ClosedAt)
				}
			}
		})
	}
}

func TestGetAccountValidation(t *testing.T) {
	tests := []struct {
		name       string
		target     string
		wantDetail api.ValidationErrorDetail
	}{
		{
			name:   "account reference too long",
			target: "/accounts/" + strings.Repeat("a", 65),
			wantDetail: api.ValidationErrorDetail{
				Location: api.Path,
				Field:    "account_reference",
				Code:     api.MaxLength,
				Message:  "account_reference must not exceed 64 characters",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			svc := &fakeService{}
			handler, err := httpapi.NewHandler(svc)
			if err != nil {
				t.Fatalf("NewHandler: %v", err)
			}

			req := httptest.NewRequest(http.MethodGet, tt.target, nil)
			rec := httptest.NewRecorder()

			handler.ServeHTTP(rec, req)

			if rec.Code != http.StatusBadRequest {
				t.Errorf("status = %d, want %d; body = %s", rec.Code, http.StatusBadRequest, rec.Body.String())
			}
			if svc.getCalls != 0 {
				t.Errorf("GetPayableAccount() calls = %d, want 0", svc.getCalls)
			}

			var got api.ValidationErrorResponse
			if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
				t.Fatalf("decode validation response: %v", err)
			}
			if len(got.Error.Details) != 1 {
				t.Fatalf("details = %+v, want one detail", got.Error.Details)
			}
			if detail := got.Error.Details[0]; detail != tt.wantDetail {
				t.Errorf("detail = %+v, want %+v", detail, tt.wantDetail)
			}
		})
	}
}

func TestGetAccountStatement_HappyPath(t *testing.T) {
	recordedAt := time.Date(2026, time.September, 10, 9, 15, 0, 0, time.UTC)
	from := time.Date(2026, time.September, 1, 0, 0, 0, 0, time.UTC)
	to := time.Date(2026, time.October, 1, 0, 0, 0, 0, time.UTC)
	desc := "Payment received"

	svc := &fakeService{
		statementResult: statement.Result{
			Account: statement.Account{
				Reference:       "acct_01M20H8704F1FDM1CFWSZDVJPV",
				HolderReference: "hld_01M20H7XK4A9Q2TZ8VG6BFP31R",
				Name:            "Acme Ltd",
			},
			Period: statement.Period{
				From: from,
				To:   to,
			},
			OpeningBalance: 0,
			ClosingBalance: 9600,
			Movements: []statement.Movement{
				{
					JournalReference: "jrn_01M20J1QD2XB8K7G4N9CVF6T3A",
					LineNumber:       1,
					Kind:             "payment",
					Direction:        statement.DirectionCredit,
					Amount:           9800,
					BalanceAfter:     9800,
					Description:      desc,
					Purpose:          "Card payment",
					RecordedAt:       recordedAt,
				},
				{
					JournalReference: "jrn_01M20J1QD2XB8K7G4N9CVF6T3A",
					LineNumber:       2,
					Kind:             "payment",
					Direction:        statement.DirectionDebit,
					Amount:           200,
					BalanceAfter:     9600,
					Description:      desc,
					Purpose:          "Processing fee",
					RecordedAt:       recordedAt,
				},
			},
			Page: statement.Page{
				Limit: 50,
				Next: &statement.Cursor{
					Navigation: statement.NavigationNext,
					Position: statement.Position{
						RecordedAt:       recordedAt,
						JournalReference: "jrn_01M20J1QD2XB8K7G4N9CVF6T3A",
						LineNumber:       2,
					},
				},
			},
		},
	}

	handler, err := httpapi.NewHandler(svc)
	if err != nil {
		t.Fatalf("NewHandler: %v", err)
	}

	target := "/accounts/acct_01M20H8704F1FDM1CFWSZDVJPV/statement?from=2026-09-01T00:00:00Z&to=2026-10-01T00:00:00Z&limit=50"
	req := httptest.NewRequest(http.MethodGet, target, nil)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body = %s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if svc.statementCalls != 1 {
		t.Fatalf("GetStatement calls = %d, want 1", svc.statementCalls)
	}

	var got api.GetAccountStatementResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode response: %v", err)
	}

	if got.Account.Reference != "acct_01M20H8704F1FDM1CFWSZDVJPV" {
		t.Errorf("Account.Reference = %q, want acct_01M20H8704F1FDM1CFWSZDVJPV", got.Account.Reference)
	}
	if got.OpeningBalance != 0 || got.ClosingBalance != 9600 {
		t.Errorf("balances = (%d, %d), want (0, 9600)", got.OpeningBalance, got.ClosingBalance)
	}
	if len(got.Entries) != 2 {
		t.Fatalf("len(Entries) = %d, want 2", len(got.Entries))
	}
	if got.Entries[0].Description != desc || got.Entries[0].Purpose != "Card payment" || got.Entries[0].Kind != "payment" {
		t.Errorf("Entries[0] = %+v", got.Entries[0])
	}
	if got.Entries[1].Description != desc || got.Entries[1].Purpose != "Processing fee" || got.Entries[1].Kind != "payment" {
		t.Errorf("Entries[1] = %+v", got.Entries[1])
	}
	if got.Page.PreviousCursor != nil {
		t.Errorf("Page.PreviousCursor = %v, want nil", got.Page.PreviousCursor)
	}
	if got.Page.NextCursor == nil || *got.Page.NextCursor == "" {
		t.Errorf("Page.NextCursor = %v, want non-empty token", got.Page.NextCursor)
	}
}

func TestGetAccountStatement_WithCursor(t *testing.T) {
	recordedAt := time.Date(2026, time.September, 10, 9, 15, 0, 0, time.UTC)
	from := time.Date(2026, time.September, 1, 0, 0, 0, 0, time.UTC)
	to := time.Date(2026, time.October, 1, 0, 0, 0, 0, time.UTC)

	cursor := &statement.Cursor{
		Navigation: statement.NavigationNext,
		Position: statement.Position{
			RecordedAt:       recordedAt,
			JournalReference: "jrn_01M20J1QD2XB8K7G4N9CVF6T3A",
			LineNumber:       2,
		},
	}
	token, err := statement.EncodeCursor(cursor, statement.Period{From: from, To: to})
	if err != nil {
		t.Fatalf("Encode: %v", err)
	}

	t.Run("with explicit limit query param", func(t *testing.T) {
		limit := 25
		svc := &fakeService{
			statementResult: statement.Result{
				Account: statement.Account{
					Reference:       "acct_01M20H8704F1FDM1CFWSZDVJPV",
					HolderReference: "hld_01M20H7XK4A9Q2TZ8VG6BFP31R",
					Name:            "Acme Ltd",
				},
				Period: statement.Period{From: from, To: to},
				Page:   statement.Page{Limit: limit},
			},
		}

		handler, err := httpapi.NewHandler(svc)
		if err != nil {
			t.Fatalf("NewHandler: %v", err)
		}

		target := "/accounts/acct_01M20H8704F1FDM1CFWSZDVJPV/statement?cursor=" + *token + "&limit=25"
		req := httptest.NewRequest(http.MethodGet, target, nil)
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want %d; body = %s", rec.Code, http.StatusOK, rec.Body.String())
		}
		if svc.statementInput.Cursor == nil {
			t.Fatal("svc.statementInput.Cursor is nil, want decoded cursor")
		}
		if svc.statementInput.Cursor.Navigation != statement.NavigationNext {
			t.Errorf("Navigation = %q, want next", svc.statementInput.Cursor.Navigation)
		}
		if svc.statementInput.Cursor.Position.JournalReference != "jrn_01M20J1QD2XB8K7G4N9CVF6T3A" {
			t.Errorf("JournalReference = %q, want jrn_01M20J1QD2XB8K7G4N9CVF6T3A", svc.statementInput.Cursor.Position.JournalReference)
		}
		if svc.statementInput.Limit != limit {
			t.Errorf("Limit = %d, want %d", svc.statementInput.Limit, limit)
		}
		if !svc.statementInput.From.Equal(from) || !svc.statementInput.To.Equal(to) {
			t.Errorf("period = (%v, %v), want (%v, %v)", svc.statementInput.From, svc.statementInput.To, from, to)
		}
	})

	t.Run("defaults limit to 50 when omitted", func(t *testing.T) {
		svc := &fakeService{
			statementResult: statement.Result{
				Account: statement.Account{
					Reference:       "acct_01M20H8704F1FDM1CFWSZDVJPV",
					HolderReference: "hld_01M20H7XK4A9Q2TZ8VG6BFP31R",
					Name:            "Acme Ltd",
				},
				Period: statement.Period{From: from, To: to},
				Page:   statement.Page{Limit: 50},
			},
		}

		handler, err := httpapi.NewHandler(svc)
		if err != nil {
			t.Fatalf("NewHandler: %v", err)
		}

		target := "/accounts/acct_01M20H8704F1FDM1CFWSZDVJPV/statement?cursor=" + *token
		req := httptest.NewRequest(http.MethodGet, target, nil)
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want %d; body = %s", rec.Code, http.StatusOK, rec.Body.String())
		}
		if svc.statementInput.Limit != 50 {
			t.Errorf("Limit = %d, want 50", svc.statementInput.Limit)
		}
	})
}

func TestGetAccountStatement_ValidationErrors(t *testing.T) {
	tests := []struct {
		name       string
		target     string
		wantField  string
		wantMsgSub string
	}{
		{
			name:       "invalid cursor",
			target:     "/accounts/acct_01M20H8704F1FDM1CFWSZDVJPV/statement?cursor=bad-token",
			wantField:  "cursor",
			wantMsgSub: "invalid pagination cursor",
		},
		{
			name:       "from after to",
			target:     "/accounts/acct_01M20H8704F1FDM1CFWSZDVJPV/statement?from=2026-10-01T00:00:00Z&to=2026-09-01T00:00:00Z",
			wantField:  "from",
			wantMsgSub: "from must be before to",
		},
		{
			name:       "period exceeds 90 days",
			target:     "/accounts/acct_01M20H8704F1FDM1CFWSZDVJPV/statement?from=2026-01-01T00:00:00Z&to=2026-06-01T00:00:00Z",
			wantField:  "from",
			wantMsgSub: "statement period must not exceed 90 days",
		},
		{
			name: "cursor exceeds 90-day limit",
			target: func() string {
				c := &statement.Cursor{
					Navigation: statement.NavigationNext,
					Position: statement.Position{
						RecordedAt:       time.Date(2026, time.September, 10, 9, 15, 0, 0, time.UTC),
						JournalReference: "jrn_01M20J1QD2XB8K7G4N9CVF6T3A",
						LineNumber:       1,
					},
				}
				tok, _ := statement.EncodeCursor(c, statement.Period{
					From: time.Date(1970, time.January, 1, 0, 0, 0, 0, time.UTC),
					To:   time.Date(2100, time.January, 1, 0, 0, 0, 0, time.UTC),
				})
				return "/accounts/acct_01M20H8704F1FDM1CFWSZDVJPV/statement?cursor=" + *tok
			}(),
			wantField:  "cursor",
			wantMsgSub: "invalid pagination cursor",
		},
		{
			name: "cursor line number exceeds max int16",
			target: func() string {
				tok := base64.RawURLEncoding.EncodeToString([]byte(`{"nav":"next","rec":"2026-09-10T09:15:00Z","jref":"jrn_01M20J1QD2XB8K7G4N9CVF6T3A","ln":40000,"from":"2026-09-01T00:00:00Z","to":"2026-09-15T00:00:00Z"}`))
				return "/accounts/acct_01M20H8704F1FDM1CFWSZDVJPV/statement?cursor=" + tok
			}(),
			wantField:  "cursor",
			wantMsgSub: "invalid pagination cursor",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			svc := &fakeService{}
			handler, err := httpapi.NewHandler(svc)
			if err != nil {
				t.Fatalf("NewHandler: %v", err)
			}

			req := httptest.NewRequest(http.MethodGet, tt.target, nil)
			rec := httptest.NewRecorder()

			handler.ServeHTTP(rec, req)

			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want %d; body = %s", rec.Code, http.StatusBadRequest, rec.Body.String())
			}

			var got api.ValidationErrorResponse
			if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
				t.Fatalf("decode validation response: %v", err)
			}
			if len(got.Error.Details) != 1 {
				t.Fatalf("details = %+v, want one detail", got.Error.Details)
			}
			detail := got.Error.Details[0]
			if detail.Field != tt.wantField {
				t.Errorf("detail.Field = %q, want %q", detail.Field, tt.wantField)
			}
			if !strings.Contains(detail.Message, tt.wantMsgSub) {
				t.Errorf("detail.Message = %q, want to contain %q", detail.Message, tt.wantMsgSub)
			}
		})
	}
}

func TestGetAccountStatement_ServiceErrors(t *testing.T) {
	tests := []struct {
		name       string
		err        error
		wantStatus int
		wantCode   api.ErrorCode
	}{
		{
			name:       "account not found",
			err:        account.ErrAccountNotFound,
			wantStatus: http.StatusNotFound,
			wantCode:   api.AccountNotFound,
		},
		{
			name:       "unexpected internal error",
			err:        errors.New("database connection failed"),
			wantStatus: http.StatusInternalServerError,
			wantCode:   api.InternalServerError,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			svc := &fakeService{statementErr: tt.err}
			handler, err := httpapi.NewHandler(svc)
			if err != nil {
				t.Fatalf("NewHandler: %v", err)
			}

			target := "/accounts/acct_01M20H8704F1FDM1CFWSZDVJPV/statement"
			req := httptest.NewRequest(http.MethodGet, target, nil)
			rec := httptest.NewRecorder()

			handler.ServeHTTP(rec, req)

			if rec.Code != tt.wantStatus {
				t.Fatalf("status = %d, want %d; body = %s", rec.Code, tt.wantStatus, rec.Body.String())
			}

			var got api.ErrorResponse
			if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
				t.Fatalf("decode error response: %v", err)
			}
			if got.Error.Code != tt.wantCode {
				t.Errorf("code = %q, want %q", got.Error.Code, tt.wantCode)
			}
		})
	}
}
