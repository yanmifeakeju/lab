package httpapi_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"yanmifeakeju.com/ledger/internal/account"
	"yanmifeakeju.com/ledger/internal/api"
	"yanmifeakeju.com/ledger/internal/httpapi"
)

type fakePayableAccountCreator struct {
	input  account.CreatePayableInput
	result account.CreateResult
	err    error
	calls  int
}

func (f *fakePayableAccountCreator) CreatePayableAccount(
	_ context.Context,
	input account.CreatePayableInput,
) (account.CreateResult, error) {
	f.input = input
	f.calls++
	return f.result, f.err
}

func TestRoutes(t *testing.T) {
	f := &fakePayableAccountCreator{}
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

	handler, err := httpapi.NewHandler(&fakePayableAccountCreator{
		result: account.CreateResult{
			Created: true,
			Account: account.Account{
				HolderName: "Acme Ltd",
				CreatedAt:  time.Now(),
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
	handler, err := httpapi.NewHandler(&fakePayableAccountCreator{})
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
					HolderName: "Acme Ltd",
					CreatedAt:  createdAt,
				},
			},
			wantStatus: http.StatusCreated,
		},
		{
			name: "idempotent retry",
			result: account.CreateResult{
				Created: false,
				Account: account.Account{
					HolderName: "Acme Ltd",
					CreatedAt:  createdAt,
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
			creator := &fakePayableAccountCreator{result: tt.result, err: tt.err}
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
