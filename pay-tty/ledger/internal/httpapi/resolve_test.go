package httpapi_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"paytty.akeju.me/ledger/internal/api"
	"paytty.akeju.me/ledger/internal/httpapi"
	"paytty.akeju.me/ledger/internal/journal"
)

const (
	pendingRef    = "jrn_01K5A2M8Q4XR7T3N9B6C1D0E2F"
	resolutionRef = "jrn_01K5A2M8Q4XR7T3N9B6C1D0E3G"
	payableRef    = "acct_01K33YV8M82N9MXP4E7J6B1QWK"
	cashRef       = "acct_0FDA2B6869DBF0755E3AC37D5D"
)

func serve(t *testing.T, service *fakeService, method, path, key, body string) *httptest.ResponseRecorder {
	t.Helper()
	handler, err := httpapi.NewHandler(service)
	if err != nil {
		t.Fatalf("NewHandler: %v", err)
	}
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if key != "" {
		req.Header.Set("Idempotency-Key", key)
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

func TestPostJournalEntry_Pending(t *testing.T) {
	service := &fakeService{postResult: journal.PostResult{
		Created: true,
		Entry: journal.Entry{
			Reference: pendingRef, Kind: "payout", State: journal.StatePending,
			Description: "Payout",
		},
	}}

	rec := serve(t, service, http.MethodPost, "/entries", "hold_1", fmt.Sprintf(`{
		"ledger": "ngn_ng", "kind": "payout", "description": "Payout",
		"pending": true,
		"lines": [{"debit_account_ref":%q,"credit_account_ref":%q,"amount":4000,"purpose":"payout"}]
	}`, payableRef, cashRef))

	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body)
	}
	if !service.postInput.Pending {
		t.Errorf("service input = %+v", service.postInput)
	}
	var got api.PostJournalEntryResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.State != api.Pending {
		t.Errorf("response state = %q, want pending", got.State)
	}
}

func TestResolveEndpoints_Validation(t *testing.T) {
	resolveItems := func(first string) string {
		items := []string{first}
		for i := 1; i < journal.MinBatchEntries; i++ {
			items = append(items, fmt.Sprintf(`{"idempotency_key":"r_%d","pending_ref":"jrn_01K5A2M8Q4XR7T3N9B6C1D0E%02d","action":"capture"}`, i, i))
		}
		return strings.Join(items, ",")
	}

	tests := []struct {
		name, path, key, body, field string
	}{
		{
			name: "resolve batch repeats a pending entry", path: "/entries/resolve/batch",
			body: fmt.Sprintf(`{"ledger":"ngn_ng","items":[%s]}`, resolveItems(
				`{"idempotency_key":"r_0","pending_ref":"jrn_01K5A2M8Q4XR7T3N9B6C1D0E01","action":"void"}`)),
			field: "items[1].pending_ref",
		},
		{
			name: "resolve batch too small", path: "/entries/resolve/batch",
			body:  fmt.Sprintf(`{"ledger":"ngn_ng","items":[{"idempotency_key":"r","pending_ref":%q,"action":"void"}]}`, pendingRef),
			field: "items",
		},
		{
			name: "resolve batch item with a removed field", path: "/entries/resolve/batch",
			body: fmt.Sprintf(`{"ledger":"ngn_ng","items":[%s]}`, resolveItems(
				`{"idempotency_key":"r_0","pending_ref":"jrn_01K5A2M8Q4XR7T3N9B6C1D0E00","action":"void","effective_at":"2026-11-07T00:00:00Z"}`)),
			field: "items[0].effective_at",
		},
		{
			name: "resolve with a removed field", path: "/entries/" + pendingRef + "/resolve", key: "k",
			body: `{"ledger":"ngn_ng","action":"void","effective_at":"2026-11-07T00:00:00Z"}`, field: "effective_at",
		},
		{
			name: "resolve unknown action", path: "/entries/" + pendingRef + "/resolve", key: "k",
			body: `{"ledger":"ngn_ng","action":"refund"}`, field: "action",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			service := &fakeService{}
			rec := serve(t, service, http.MethodPost, tc.path, tc.key, tc.body)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, body %s", rec.Code, rec.Body)
			}
			var got api.ValidationErrorResponse
			if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
				t.Fatal(err)
			}
			if len(got.Error.Details) != 1 || got.Error.Details[0].Field != tc.field {
				t.Errorf("details = %+v, want field %q", got.Error.Details, tc.field)
			}
			if service.postCalls+service.batchCalls+service.resolveCalls+service.rbatchCalls != 0 {
				t.Error("service was called")
			}
		})
	}
}

func TestResolveJournalEntry_Responses(t *testing.T) {
	created := time.Date(2026, time.November, 7, 9, 0, 0, 0, time.UTC)
	resolution := journal.Resolution{
		Reference: resolutionRef, RequestID: "cap", Kind: "payout", Description: "Payout",
		CreatedAt: created, PendingReference: pendingRef, PendingState: journal.StateCaptured,
	}

	tests := []struct {
		name       string
		result     journal.ResolveResult
		err        error
		wantStatus int
		wantCode   api.ErrorCode
	}{
		{name: "created", result: journal.ResolveResult{Resolution: resolution, Created: true}, wantStatus: http.StatusCreated},
		{name: "replay", result: journal.ResolveResult{Resolution: resolution}, wantStatus: http.StatusOK},
		{name: "not found", err: fmt.Errorf("x: %w", journal.ErrEntryNotFound), wantStatus: http.StatusNotFound, wantCode: api.EntryNotFound},
		{name: "not pending", err: fmt.Errorf("x: %w", journal.ErrEntryNotPending), wantStatus: http.StatusConflict, wantCode: api.EntryNotPending},
		{name: "conflict", err: fmt.Errorf("x: %w", journal.ErrIdempotencyConflict), wantStatus: http.StatusConflict, wantCode: api.IdempotencyConflict},
		{
			name:       "resolved",
			err:        &journal.ResolvedError{PendingState: journal.StateVoided, ResolutionReference: resolutionRef},
			wantStatus: http.StatusConflict, wantCode: api.EntryResolved,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			service := &fakeService{resolveResult: tc.result, resolveErr: tc.err}
			rec := serve(t, service, http.MethodPost, "/entries/"+pendingRef+"/resolve", "cap", `{"ledger":"ngn_ng","action":"capture"}`)
			if rec.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d; body %s", rec.Code, tc.wantStatus, rec.Body)
			}
			if service.resolveInput.PendingReference != pendingRef || service.resolveInput.Action != journal.ActionCapture || service.resolveInput.RequestID != "cap" {
				t.Errorf("service input = %+v", service.resolveInput)
			}

			if tc.err == nil {
				var got api.ResolveJournalEntryResponse
				if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
					t.Fatal(err)
				}
				if got.JournalRef != resolutionRef || got.PendingRef != pendingRef || got.PendingState != api.Captured || got.LedgerSlug != "ngn_ng" {
					t.Errorf("response = %+v", got)
				}
				return
			}

			var got api.ResolveConflictResponse
			if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
				t.Fatal(err)
			}
			if got.Error.Code != tc.wantCode {
				t.Errorf("code = %q, want %q", got.Error.Code, tc.wantCode)
			}
			if tc.wantCode == api.EntryResolved {
				if got.PendingState == nil || *got.PendingState != api.Voided || got.ResolvedBy == nil || *got.ResolvedBy != resolutionRef {
					t.Errorf("winner = (%v, %v)", got.PendingState, got.ResolvedBy)
				}
			} else if got.PendingState != nil || got.ResolvedBy != nil {
				t.Errorf("winner details on %s", tc.wantCode)
			}
		})
	}
}

func TestResolveJournalEntriesBatch_HappyPath(t *testing.T) {
	captured := journal.StateCaptured
	voided := journal.StateVoided
	winner := resolutionRef
	ref := resolutionRef
	results := []journal.ResolveBatchItemResult{
		{RequestID: "r_0", PendingReference: pendingRef, Status: journal.BatchItemCreated, JournalRef: &ref, PendingState: &captured},
		{
			RequestID: "r_1", PendingReference: "jrn_01K5A2M8Q4XR7T3N9B6C1D0E01", Status: journal.BatchItemRejected,
			PendingState: &voided, ResolvedBy: &winner,
			Error: &journal.BatchItemError{Code: "entry_resolved", Message: "Entry is already voided."},
		},
	}
	service := &fakeService{rbatchResult: journal.ResolveBatchResult{Results: results}}

	items := make([]string, journal.MinBatchEntries)
	for i := range items {
		ref := pendingRef
		if i > 0 {
			ref = fmt.Sprintf("jrn_01K5A2M8Q4XR7T3N9B6C1D0E%02d", i)
		}
		items[i] = fmt.Sprintf(`{"idempotency_key":"r_%d","pending_ref":%q,"action":"capture"}`, i, ref)
	}
	rec := serve(t, service, http.MethodPost, "/entries/resolve/batch", "", fmt.Sprintf(`{"ledger":"ngn_ng","items":[%s]}`, strings.Join(items, ",")))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body)
	}
	if len(service.rbatchInput.Items) != journal.MinBatchEntries {
		t.Errorf("service input = %+v", service.rbatchInput)
	}

	var got api.BatchResolveEntriesResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if r := got.Results[0]; r.Status != api.BatchResolveEntryResultStatusCreated || *r.JournalRef != resolutionRef || *r.PendingState != api.Captured || r.ResolvedBy != nil {
		t.Errorf("result 0 = %+v", r)
	}
	if r := got.Results[1]; r.Status != api.BatchResolveEntryResultStatusRejected || r.JournalRef != nil || *r.PendingState != api.Voided || *r.ResolvedBy != resolutionRef || r.Error.Code != api.EntryResolved {
		t.Errorf("result 1 = %+v", r)
	}
}
