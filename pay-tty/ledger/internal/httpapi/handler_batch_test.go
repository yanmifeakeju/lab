package httpapi_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"yanmifeakeju.com/ledger/internal/api"
	"yanmifeakeju.com/ledger/internal/httpapi"
	"yanmifeakeju.com/ledger/internal/journal"
)

func TestPostJournalEntriesBatch_HappyPath(t *testing.T) {
	service := &fakeService{}
	ref1 := "jrn_01K5A2M8Q4XR7T3N9B6C1D0E2F"
	service.batchResult = journal.BatchResult{
		Results: []journal.BatchItemResult{
			{
				RequestID:  "pay_1",
				Status:     journal.BatchItemCreated,
				JournalRef: &ref1,
			},
			{
				RequestID: "payout_2",
				Status:    journal.BatchItemRejected,
				Error: &journal.BatchItemError{
					Code:    "insufficient_funds",
					Message: "Insufficient funds.",
				},
			},
		},
	}

	handler, err := httpapi.NewHandler(service)
	if err != nil {
		t.Fatalf("NewHandler: %v", err)
	}

	body := batchBody(
		`{
			"idempotency_key": "pay_1",
			"kind": "payment",
			"description": "Card payment",
			"lines": [{"debit_account_ref":"acct_01K33YV8M82N9MXP4E7J6B1QWK","credit_account_ref":"acct_0FDA2B6869DBF0755E3AC37D5D","amount":10000,"purpose":"Payment"}]
		}`,
		`{
			"idempotency_key": "payout_2",
			"kind": "payout",
			"description": "Payout",
			"lines": [{"debit_account_ref":"acct_01K33YV8M82N9MXP4E7J6B1QWK","credit_account_ref":"acct_0FDA2B6869DBF0755E3AC37D5D","amount":5000,"purpose":"Payout"}]
		}`,
	)

	req := httptest.NewRequest(http.MethodPost, "/entries/batch", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body = %s", rec.Code, rec.Body.String())
	}
	if service.batchCalls != 1 {
		t.Errorf("PostEntries calls = %d, want 1", service.batchCalls)
	}

	var got api.BatchPostEntriesResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}

	if len(got.Results) != 2 {
		t.Fatalf("got %d results, want 2", len(got.Results))
	}

	// Result 0: created
	if got.Results[0].IdempotencyKey != "pay_1" || got.Results[0].Status != api.Created {
		t.Errorf("result[0] = %+v", got.Results[0])
	}
	if got.Results[0].JournalRef == nil || *got.Results[0].JournalRef != ref1 {
		t.Errorf("result[0].JournalRef = %v, want %s", got.Results[0].JournalRef, ref1)
	}
	if got.Results[0].Error != nil {
		t.Errorf("result[0].Error = %v, want nil", got.Results[0].Error)
	}

	// Result 1: rejected
	if got.Results[1].IdempotencyKey != "payout_2" || got.Results[1].Status != api.Rejected {
		t.Errorf("result[1] = %+v", got.Results[1])
	}
	if got.Results[1].JournalRef != nil {
		t.Errorf("result[1].JournalRef = %v, want nil", got.Results[1].JournalRef)
	}
	if got.Results[1].Error == nil || got.Results[1].Error.Code != api.InsufficientFunds {
		t.Errorf("result[1].Error = %v, want insufficient_funds", got.Results[1].Error)
	}
}

func TestPostJournalEntriesBatch_ValidationErrors(t *testing.T) {
	tests := []struct {
		name       string
		entries    []string
		body       string // set instead of entries when the whole body is the point
		wantField  string
		wantCode   api.ValidationErrorDetailCode
		wantStatus int
	}{
		{
			name: "duplicate idempotency key within batch",
			entries: []string{
				`{"idempotency_key":"dup_key","kind":"payment","description":"Leg 1","lines":[{"debit_account_ref":"acct_1","credit_account_ref":"acct_2","amount":100,"purpose":"P"}]}`,
				`{"idempotency_key":"dup_key","kind":"payment","description":"Leg 2","lines":[{"debit_account_ref":"acct_1","credit_account_ref":"acct_2","amount":200,"purpose":"P"}]}`,
			},
			wantField:  "entries[1].idempotency_key",
			wantCode:   api.InvalidValue,
			wantStatus: http.StatusBadRequest,
		},
		{
			name: "self transfer within entry",
			entries: []string{
				`{"idempotency_key":"k1","kind":"payment","description":"Leg 1","lines":[{"debit_account_ref":"acct_1","credit_account_ref":"acct_1","amount":100,"purpose":"P"}]}`,
			},
			wantField:  "entries[0].lines[0]",
			wantCode:   api.InvalidValue,
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "empty entries",
			body:       `{"ledger":"ngn_ng","entries":[]}`,
			wantStatus: http.StatusBadRequest,
		},
		{
			name: "fewer entries than the minimum",
			body: `{
				"ledger": "ngn_ng",
				"entries": [
					{
						"idempotency_key": "k1",
						"kind": "payment",
						"description": "Leg 1",
						"lines": [{"debit_account_ref":"acct_1","credit_account_ref":"acct_2","amount":100,"purpose":"P"}]
					}
				]
			}`,
			wantField:  "entries",
			wantCode:   api.InvalidValue,
			wantStatus: http.StatusBadRequest,
		},
		{
			name: "empty lines array in entry",
			entries: []string{
				`{"idempotency_key":"k1","kind":"payment","description":"Leg 1","lines":[]}`,
			},
			wantStatus: http.StatusBadRequest,
		},
		{
			name: "whitespace-only kind in entry",
			entries: []string{
				`{"idempotency_key":"k1","kind":"   \u00a0   ","description":"Leg 1","lines":[{"debit_account_ref":"acct_1","credit_account_ref":"acct_2","amount":100,"purpose":"P"}]}`,
			},
			wantField:  "entries[0].kind",
			wantCode:   api.InvalidValue,
			wantStatus: http.StatusBadRequest,
		},
		{
			name: "whitespace-only description in entry",
			entries: []string{
				`{"idempotency_key":"k1","kind":"payment","description":"   \u00a0   ","lines":[{"debit_account_ref":"acct_1","credit_account_ref":"acct_2","amount":100,"purpose":"P"}]}`,
			},
			wantField:  "entries[0].description",
			wantCode:   api.InvalidValue,
			wantStatus: http.StatusBadRequest,
		},
		{
			name: "whitespace-only purpose in line",
			entries: []string{
				`{"idempotency_key":"k1","kind":"payment","description":"Leg 1","lines":[{"debit_account_ref":"acct_1","credit_account_ref":"acct_2","amount":100,"purpose":"   \u00a0   "}]}`,
			},
			wantField:  "entries[0].lines[0].purpose",
			wantCode:   api.InvalidValue,
			wantStatus: http.StatusBadRequest,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			service := &fakeService{}
			handler, err := httpapi.NewHandler(service)
			if err != nil {
				t.Fatalf("NewHandler: %v", err)
			}

			body := tt.body
			if body == "" {
				body = batchBody(tt.entries...)
			}

			req := httptest.NewRequest(http.MethodPost, "/entries/batch", strings.NewReader(body))
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()

			handler.ServeHTTP(rec, req)

			if rec.Code != tt.wantStatus {
				t.Fatalf("status = %d, want %d; body = %s", rec.Code, tt.wantStatus, rec.Body.String())
			}
			if service.batchCalls != 0 {
				t.Errorf("PostEntries calls = %d, want 0", service.batchCalls)
			}
		})
	}
}

func TestPostJournalEntriesBatch_DomainErrors(t *testing.T) {
	tests := []struct {
		name       string
		serviceErr error
		wantStatus int
		wantCode   api.ErrorCode
	}{
		{
			name:       "ledger not found returns 404",
			serviceErr: journal.ErrLedgerNotFound,
			wantStatus: http.StatusNotFound,
			wantCode:   api.LedgerNotFound,
		},
		{
			name:       "ledger closed returns 409",
			serviceErr: journal.ErrLedgerClosed,
			wantStatus: http.StatusConflict,
			wantCode:   api.LedgerClosed,
		},
		{
			name:       "blank purpose returns 400",
			serviceErr: journal.ErrBlankPurpose,
			wantStatus: http.StatusBadRequest,
			wantCode:   api.ErrorCode("validation_error"),
		},
		{
			name:       "blank description returns 400",
			serviceErr: journal.ErrBlankDescription,
			wantStatus: http.StatusBadRequest,
			wantCode:   api.ErrorCode("validation_error"),
		},
		{
			name:       "blank kind returns 400",
			serviceErr: journal.ErrBlankKind,
			wantStatus: http.StatusBadRequest,
			wantCode:   api.ErrorCode("validation_error"),
		},
		{
			name:       "batch size exceeded returns 400",
			serviceErr: journal.ErrBatchSizeExceeded,
			wantStatus: http.StatusBadRequest,
			wantCode:   api.ErrorCode("validation_error"),
		},
		{
			name:       "batch lines exceeded returns 400",
			serviceErr: journal.ErrBatchLinesExceeded,
			wantStatus: http.StatusBadRequest,
			wantCode:   api.ErrorCode("validation_error"),
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			service := &fakeService{batchErr: tt.serviceErr}
			handler, err := httpapi.NewHandler(service)
			if err != nil {
				t.Fatalf("NewHandler: %v", err)
			}

			body := batchBody()

			req := httptest.NewRequest(http.MethodPost, "/entries/batch", strings.NewReader(body))
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()

			handler.ServeHTTP(rec, req)

			if rec.Code != tt.wantStatus {
				t.Fatalf("status = %d, want %d; body = %s", rec.Code, tt.wantStatus, rec.Body.String())
			}

			if tt.wantStatus == http.StatusBadRequest {
				var valErr api.ValidationErrorResponse
				if err := json.Unmarshal(rec.Body.Bytes(), &valErr); err != nil {
					t.Fatalf("unmarshal error response: %v", err)
				}
				if string(valErr.Error.Code) != string(tt.wantCode) {
					t.Errorf("error code = %s, want %s", valErr.Error.Code, tt.wantCode)
				}
			} else {
				var got api.ErrorResponse
				if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
					t.Fatalf("unmarshal error response: %v", err)
				}
				if got.Error.Code != tt.wantCode {
					t.Errorf("error code = %s, want %s", got.Error.Code, tt.wantCode)
				}
			}
		})
	}
}

// batchBody builds a request body from the given entry objects, padded with
// filler entries up to the endpoint's minimum. Without the padding every case
// here would fail the size check before reaching what it means to test.
func batchBody(entries ...string) string {
	all := append([]string{}, entries...)
	for i := len(all); i < journal.MinBatchEntries; i++ {
		all = append(all, fmt.Sprintf(`{
			"idempotency_key": "pad_%d",
			"kind": "payment",
			"description": "Batch filler",
			"lines": [{"debit_account_ref":"acct_1","credit_account_ref":"acct_2","amount":1,"purpose":"Filler"}]
		}`, i))
	}
	return `{"ledger":"ngn_ng","entries":[` + strings.Join(all, ",") + `]}`
}
