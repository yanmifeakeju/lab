package httpapi

import "net/http"

// Use chains the given middlewares into a single middleware. The middlewares
// are applied in order, with the first provided middleware becoming the
// outermost wrapper of the returned handler.
func Use(middlewares ...func(http.Handler) http.Handler) func(http.Handler) http.Handler {
	return func(handler http.Handler) http.Handler {
		for i := len(middlewares) - 1; i >= 0; i-- {
			handler = middlewares[i](handler)
		}

		return handler
	}
}

// With returns a register function that wraps every handler registered on the
// given mux with the provided middleware chain, so each route is automatically
// decorated without requiring manual wrapping at each call site.
func With(mux *http.ServeMux, middlewares ...func(http.Handler) http.Handler) func(pattern string, handler http.Handler) {
	middleware := Use(middlewares...)

	return func(pattern string, handler http.Handler) {
		mux.Handle(pattern, middleware(handler))
	}
}
