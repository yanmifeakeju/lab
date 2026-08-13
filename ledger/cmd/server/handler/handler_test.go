package handler_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"yanmifeakeju.com/ledger/cmd/server/handler"
)

func TestRoutes(t *testing.T) {
	h, err := handler.New()
	if err != nil {
		t.Fatalf("New %v", err)
	}

	mux := h.Routes()

	cases := []struct {
		name       string
		method     string
		target     string
		wantStatus int
		wantBody   *handler.HealthResponse
	}{
		{
			name:   "health ok",
			method: "GET",
			target: "/health", wantStatus: http.StatusOK,
			wantBody: &handler.HealthResponse{Status: "ok"},
		},
		{
			name:       "health wrong method",
			method:     "POST",
			target:     "/health",
			wantStatus: http.StatusMethodNotAllowed,
		},
		{
			name:       "unknown route",
			method:     "GET",
			target:     "/nope",
			wantStatus: http.StatusNotFound,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			req := httptest.NewRequest(tc.method, tc.target, nil)
			rec := httptest.NewRecorder()

			mux.ServeHTTP(rec, req)

			if rec.Code != tc.wantStatus {
				t.Errorf("status = %d, want %d", rec.Code, tc.wantStatus)
			}

			if tc.wantBody != nil {
				var got handler.HealthResponse
				if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
					t.Fatalf("decode %v", err)
				}

				if got != *tc.wantBody {
					t.Errorf("body = %+v, want %+v", got, tc.wantBody)
				}
			}
		})
	}
}
