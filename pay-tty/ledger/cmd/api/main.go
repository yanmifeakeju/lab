package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"yanmifeakeju.com/ledger/internal/config"
	"yanmifeakeju.com/ledger/internal/database"
	"yanmifeakeju.com/ledger/internal/httpapi"
	"yanmifeakeju.com/ledger/internal/postgres"
)

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	cfg, err := config.LoadEnvConfig()
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}

	startupCtx, cancelStartup := context.WithTimeout(context.Background(), 10*time.Second)
	db, err := database.Open(startupCtx, cfg.Database.URL, cfg.Database.MaxConns)
	cancelStartup()
	if err != nil {
		return fmt.Errorf("open database: %w", err)
	}
	defer func() {
		if err := db.Close(); err != nil {
			log.Printf("close database: %v", err)
		}
	}()

	accounts := postgres.New(db)
	apiHandler, err := httpapi.NewHandler(accounts)
	if err != nil {
		return fmt.Errorf("build HTTP API: %w", err)
	}

	srv := &http.Server{
		Addr:              cfg.Server.Address,
		Handler:           apiHandler,
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	shutdownSignal, stop := signal.NotifyContext(
		context.Background(),
		os.Interrupt,
		syscall.SIGTERM,
	)
	defer stop()

	serverErr := make(chan error, 1)
	go func() {
		log.Printf("listening on %s", srv.Addr)
		serverErr <- srv.ListenAndServe()
	}()

	select {
	case err := <-serverErr:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			return fmt.Errorf("serve HTTP: %w", err)
		}
		return nil
	case <-shutdownSignal.Done():
		log.Print("shutting down HTTP server")
	}

	// Restore the default signal behavior so a second signal forces exit.
	stop()

	shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancelShutdown()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("shut down HTTP server: %w", err)
	}

	if err := <-serverErr; err != nil && !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("serve HTTP: %w", err)
	}

	return nil
}
