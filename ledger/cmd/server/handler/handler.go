// Package handler exposes the HTTP surface of the ledger API.
//
// Construct a [Handler] with [New] and register it on an [*http.ServeMux]
// via [Handler.Routes]. Middleware is applied per-route through [With], so
// each handler registered on the returned mux is automatically wrapped with
// the supplied chain.
package handler

import (
	"encoding/json"
	"net/http"
)

// Handler serves HTTP requests for the ledger API.
type Handler struct{}

// New returns a [Handler] ready to register routes on. It performs no work
// today, but exists so future dependencies (stores, loggers, etc.) can be
// injected here without changing call sites.
func New() (*Handler, error) {
	h := &Handler{}

	return h, nil
}

// HealthResponse is the JSON body returned by the GET /health route.
type HealthResponse struct {
	Status string `json:"status"`
}

// Routes builds a new [*http.ServeMux] with the ledger routes registered on
// it. Each middleware in middlewares is applied to every route via [With],
// in the order given, with the first middleware becoming the outermost
// wrapper. The returned mux is safe to serve directly.
func (h *Handler) Routes(middlewares ...func(http.Handler) http.Handler) *http.ServeMux {
	mux := http.NewServeMux()
	register := With(mux, middlewares...)

	register("GET /health", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(HealthResponse{Status: "ok"})
	}))

	return mux
}
