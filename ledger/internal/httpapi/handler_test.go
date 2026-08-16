package httpapi_test

import (
	"context"
	"encoding/json"
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
	result account.CreateResult
	err    error
}

func (f fakePayableAccountCreator) CreatePayableAccount(
	context.Context,
	account.CreatePayableInput,
) (account.CreateResult, error) {
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

func TestCreateAccountValidation(t *testing.T) {
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

	handler, err := httpapi.NewHandler(fakePayableAccountCreator{
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
	handler, err := httpapi.NewHandler(fakePayableAccountCreator{})
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
