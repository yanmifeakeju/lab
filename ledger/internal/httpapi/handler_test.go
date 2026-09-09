package httpapi_test

import (
	"context"
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
)

type fakeService struct {
	input      account.CreatePayableInput
	result     account.CreateResult
	err        error
	calls      int
	postInput  journal.PostInput
	postResult journal.PostResult
	postErr    error
	postCalls  int
	getInput   account.GetPayableAccountInput
	getResult  account.GetPayableAccountResult
	getErr     error
	getCalls   int
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
	input account.GetPayableAccountInput,
) (account.GetPayableAccountResult, error) {
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
			target:     "/ledgers/ngn_ng/accounts",
			body:       `{"external_id":"merchant_1","name":"Acme Ltd"}`,
			wantStatus: http.StatusCreated,
		},
		{
			name:   "all missing required fields",
			target: "/ledgers/ngn_ng/accounts",
			body:   `{}`,
			wantDetails: []api.ValidationErrorDetail{
				{Location: api.Body, Field: "external_id", Code: api.Required},
				{Location: api.Body, Field: "name", Code: api.Required},
			},
			wantStatus: http.StatusBadRequest,
		},
		{
			name:   "external ID has wrong type",
			target: "/ledgers/ngn_ng/accounts",
			body:   `{"external_id":2222222,"name":"Acme Ltd"}`,
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
			target: "/ledgers/ngn_ng/accounts",
			body:   `{"external_id":"merchant_1","name":"   "}`,
			wantDetails: []api.ValidationErrorDetail{
				{Location: api.Body, Field: "name", Code: api.InvalidFormat, Message: "name must not be blank"},
			},
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "unknown fields are ignored",
			target:     "/ledgers/ngn_ng/accounts",
			body:       `{"external_id":"merchant_1","name":"Acme Ltd","another":true,"extra":true}`,
			wantStatus: http.StatusCreated,
		},
		{
			name:   "invalid ledger slug shape",
			target: "/ledgers/bad__slug/accounts",
			body:   `{"external_id":"merchant_1","name":"Acme Ltd"}`,
			wantDetails: []api.ValidationErrorDetail{
				{
					Location: api.Path,
					Field:    "slug",
					Code:     api.InvalidFormat,
					Message:  "slug must contain lowercase letters and numbers separated by single underscores",
				},
			},
			wantStatus: http.StatusBadRequest,
		},
		{
			name:   "malformed JSON",
			target: "/ledgers/ngn_ng/accounts",
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
			Account: account.Account{
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
	}{
		{
			name: "created",
			result: account.CreateResult{
				Created: true,
				Account: account.Account{
					Reference:       accountRef,
					HolderReference: holderRef,
					HolderName:      "Acme Ltd",
					CreatedAt:       createdAt,
				},
			},
			wantStatus: http.StatusCreated,
		},
		{
			name: "idempotent retry",
			result: account.CreateResult{
				Created: false,
				Account: account.Account{
					Reference:       accountRef,
					HolderReference: holderRef,
					HolderName:      "Acme Ltd",
					CreatedAt:       createdAt,
				},
			},
			wantStatus: http.StatusOK,
		},
		{
			name:        "ledger not found",
			err:         fmt.Errorf("create payable account: %w", account.ErrLedgerNotFound),
			wantStatus:  http.StatusNotFound,
			wantCode:    api.LedgerNotFound,
			wantMessage: "Ledger not found.",
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
				"/ledgers/ngn_ng/accounts",
				strings.NewReader(`{"external_id":"merchant_1","name":"Acme Ltd"}`),
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

			if tt.wantCode == "" {
				var got api.CreatePayableAccountResponse
				if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
					t.Fatalf("decode success response: %v", err)
				}
				if got.LedgerSlug != api.LedgerSlug(wantInput.LedgerSlug) {
					t.Errorf("ledger_slug = %q, want %q", got.LedgerSlug, wantInput.LedgerSlug)
				}
				if got.AccountRef != accountRef {
					t.Errorf("account_ref = %q, want %q", got.AccountRef, accountRef)
				}
				if got.HolderRef != holderRef {
					t.Errorf("holder_ref = %q, want %q", got.HolderRef, holderRef)
				}
				if got.ExternalID != wantInput.ExternalID {
					t.Errorf("external_id = %q, want %q", got.ExternalID, wantInput.ExternalID)
				}
				if got.Name != tt.result.Account.HolderName {
					t.Errorf("name = %q, want %q", got.Name, tt.result.Account.HolderName)
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
			Account: account.Account{
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
		"/ledgers/ngn_ng/accounts",
		strings.NewReader(`{"external_id":"merchant_1","name":"  Acme Ltd  "}`),
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
		"kind":"payment",
		"lines":[{
			"debit_account_ref":"acct_cash",
			"credit_account_ref":"acct_payable",
			"amount":10000
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
			name: "missing body fields",
			body: `{}`,
			key:  "payment_123",
			wantDetails: []api.ValidationErrorDetail{
				{Location: api.Body, Field: "kind", Code: api.Required},
				{Location: api.Body, Field: "lines", Code: api.Required},
			},
		},
		{
			name: "unsupported kind",
			body: `{
				"kind":"refund",
				"lines":[{
					"debit_account_ref":"acct_cash",
					"credit_account_ref":"acct_payable",
					"amount":10000
				}]
			}`,
			key: "payment_123",
			wantDetails: []api.ValidationErrorDetail{
				{
					Location: api.Body,
					Field:    "kind",
					Code:     api.InvalidValue,
					Message:  "kind must be one of: payment, settlement, transfer",
				},
			},
		},
		{
			name: "no lines",
			body: `{"kind":"payment","lines":[]}`,
			key:  "payment_123",
			wantDetails: []api.ValidationErrorDetail{
				{Location: api.Body, Field: "lines", Code: api.InvalidValue},
			},
		},
		{
			name: "non-positive amount",
			body: `{
				"kind":"payment",
				"lines":[{
					"debit_account_ref":"acct_cash",
					"credit_account_ref":"acct_payable",
					"amount":0
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
				"kind":"payment",
				"lines":[{
					"debit_account_ref":"acct_same",
					"credit_account_ref":"acct_same",
					"amount":10000
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
				"/ledgers/ngn_ng/entries",
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

func TestPostJournalEntryResponses(t *testing.T) {
	effectiveAt := time.Date(2026, time.September, 8, 10, 30, 0, 0, time.UTC)
	createdAt := effectiveAt.Add(time.Second)
	description := "Payment received"

	wantInput := journal.PostInput{
		LedgerSlug:  "ngn_ng",
		RequestID:   "payment_123",
		Kind:        journal.KindPayment,
		Description: &description,
		EffectiveAt: &effectiveAt,
		Lines: []journal.LineInput{
			{
				DebitAccountReference:  "acct_cash",
				CreditAccountReference: "acct_payable",
				Amount:                 10_000,
			},
		},
	}
	postedEntry := journal.Entry{
		Reference:   "jrn_01K33YW0MDHJ9E4N7Z2QPV6R8K",
		Kind:        journal.KindPayment,
		State:       journal.StatePosted,
		Description: &description,
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
		validation  bool
	}{
		{name: "created", result: journal.PostResult{Entry: postedEntry, Created: true}, wantStatus: http.StatusCreated},
		{name: "idempotent retry", result: journal.PostResult{Entry: postedEntry}, wantStatus: http.StatusOK},
		{name: "ledger not found", err: journal.ErrLedgerNotFound, wantStatus: http.StatusNotFound, wantCode: api.LedgerNotFound, wantMessage: "Ledger not found."},
		{name: "account not found", err: journal.ErrAccountNotFound, wantStatus: http.StatusNotFound, wantCode: api.AccountNotFound, wantMessage: "Account not found."},
		{name: "ledger closed", err: journal.ErrLedgerClosed, wantStatus: http.StatusConflict, wantCode: api.LedgerClosed, wantMessage: "Ledger is closed."},
		{name: "account closed", err: journal.ErrAccountClosed, wantStatus: http.StatusConflict, wantCode: api.AccountClosed, wantMessage: "Account is closed."},
		{name: "insufficient funds", err: journal.ErrInsufficientFunds, wantStatus: http.StatusConflict, wantCode: api.InsufficientFunds, wantMessage: "Insufficient funds."},
		{name: "idempotency conflict", err: journal.ErrIdempotencyConflict, wantStatus: http.StatusConflict, wantCode: api.IdempotencyConflict, wantMessage: "Idempotency key conflicts with a previous request."},
		{name: "defensive no lines", err: journal.ErrNoLines, wantStatus: http.StatusBadRequest, validation: true},
		{name: "defensive self transfer", err: journal.ErrNoSelfTransfer, wantStatus: http.StatusBadRequest, validation: true},
		{name: "defensive non-positive amount", err: journal.ErrNonPositiveAmount, wantStatus: http.StatusBadRequest, validation: true},
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
				"/ledgers/ngn_ng/entries",
				strings.NewReader(`{
					"kind":"payment",
					"description":"  Payment received  ",
					"effective_at":"2026-09-08T10:30:00Z",
					"lines":[{
						"debit_account_ref":"acct_cash",
						"credit_account_ref":"acct_payable",
						"amount":10000
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
			case tt.validation:
				var got api.ValidationErrorResponse
				if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
					t.Fatalf("decode validation response: %v", err)
				}
				if got.Error.Code != api.ValidationErrorCodeValidationError || len(got.Error.Details) != 1 {
					t.Errorf("validation error = %+v", got.Error)
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
				if got.LedgerSlug != "ngn_ng" || got.Kind != api.Payment || got.State != api.Posted {
					t.Errorf("response identity = %+v", got)
				}
				if got.Description == nil || *got.Description != description {
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

	tests := []struct {
		name        string
		result      account.GetPayableAccountResult
		err         error
		wantStatus  int
		wantCode    api.ErrorCode
		wantMessage string
	}{
		{
			name: "successful lookup",
			result: account.GetPayableAccountResult{
				Reference:  accountRef,
				Kind:       account.KindPayable,
				LedgerSlug: ledgerSlug,
				Balances: account.BalanceCounters{
					DebitsPending:  200,
					CreditsPending: 0,
					DebitsPosted:   0,
					CreditsPosted:  10000,
				},
				CreatedAt: createdAt,
			},
			wantStatus: http.StatusOK,
		},
		{
			name:        "ledger not found",
			err:         fmt.Errorf("get payable account: %w", account.ErrLedgerNotFound),
			wantStatus:  http.StatusNotFound,
			wantCode:    api.LedgerNotFound,
			wantMessage: "Ledger not found.",
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
				fmt.Sprintf("/ledgers/%s/accounts/%s", ledgerSlug, accountRef),
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
			if svc.getInput.LedgerSlug != ledgerSlug {
				t.Errorf("GetPayableAccount() LedgerSlug = %q, want %q", svc.getInput.LedgerSlug, ledgerSlug)
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
				if got.AccountRef != accountRef {
					t.Errorf("account_ref = %q, want %q", got.AccountRef, accountRef)
				}
				if got.LedgerSlug != ledgerSlug {
					t.Errorf("ledger_slug = %q, want %q", got.LedgerSlug, ledgerSlug)
				}
				if got.Kind != api.Payable {
					t.Errorf("kind = %q, want %q", got.Kind, api.Payable)
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
			}
		})
	}
}

func TestGetAccountValidation(t *testing.T) {
	tests := []struct {
		name       string
		target     string
		wantStatus int
	}{
		{
			name:       "invalid ledger slug characters",
			target:     "/ledgers/invalid-slug!/accounts/acct_01K33YV8M82N9MXP4E7J6B1QWK",
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "ledger slug too short",
			target:     "/ledgers/ab/accounts/acct_01K33YV8M82N9MXP4E7J6B1QWK",
			wantStatus: http.StatusBadRequest,
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

			if rec.Code != tt.wantStatus {
				t.Errorf("status = %d, want %d; body = %s", rec.Code, tt.wantStatus, rec.Body.String())
			}
			if svc.getCalls != 0 {
				t.Errorf("GetPayableAccount() calls = %d, want 0", svc.getCalls)
			}
		})
	}
}

