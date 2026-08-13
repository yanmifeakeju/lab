package main

import (
	"errors"
	"log"
	"net/http"

	"yanmifeakeju.com/ledger/cmd/server/handler"
	"yanmifeakeju.com/ledger/internal/config"
)

func main() {
	cfg, err := config.LoadEnvConfig()
	if err != nil {
		log.Fatalf("failed to parse config: %v", err)
	}

	h, err := handler.New()
	if err != nil {
		log.Fatalf("failed to init handler: %v", err)
	}

	mux := h.Routes()
	srv := &http.Server{
		Addr:    cfg.Server.Address,
		Handler: mux,
	}

	log.Printf("listening on %s\n", srv.Addr)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("server error: %v", err)
	}

}
