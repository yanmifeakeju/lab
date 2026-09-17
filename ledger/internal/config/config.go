// Package config loads runtime configuration for the ledger server.
//
// Use [LoadEnvConfig] to build a [Config] from the process environment.
package config

import (
	"errors"
	"fmt"
	"os"

	"github.com/joho/godotenv"
)

// Config holds runtime configuration for the server. Fields are populated
// from the process environment by [LoadEnvConfig].
type Config struct {
	// Server holds HTTP server settings.
	Server struct {
		// Address is the listen address for the HTTP server, in the
		// form "host:port" accepted by [*http.Server].Addr.
		Address string
	}
	Database struct {
		URL string
	}
}

// LoadEnvConfig builds a [Config] from the process environment.
//
// The following variables are read:
//
//   - SERVER_ADDRESS - the HTTP listen address. Defaults to ":8080" when
//     unset or empty.
//   - DATABASE_URL - the PostgreSQL connection URL. Required.
//
// Returns an error if the optional .env file cannot be parsed or DATABASE_URL
// is empty.
func LoadEnvConfig() (Config, error) {
	var cfg Config
	// .env is a dev convenience; production injects env vars natively.
	// A missing file is fine — only fail if it exists but won't parse.
	if err := godotenv.Load(); err != nil {
		if !os.IsNotExist(err) {
			return cfg, fmt.Errorf("parse .env: %w", err)
		}
	}

	cfg.Server.Address = os.Getenv("SERVER_ADDRESS")
	if cfg.Server.Address == "" {
		cfg.Server.Address = ":8080"
	}

	cfg.Database.URL = os.Getenv("DATABASE_URL")
	if cfg.Database.URL == "" {
		return cfg, errors.New("config database url is not set")
	}

	return cfg, nil
}
