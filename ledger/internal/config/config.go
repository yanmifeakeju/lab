// Package config loads runtime configuration for the ledger server.
//
// Use [LoadEnvConfig] to build a [Config] from the process environment.
package config

import (
	"os"
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
}

// LoadEnvConfig builds a [Config] from the process environment.
//
// The following variables are read:
//
//   - SERVER_ADDRESS - the HTTP listen address. Defaults to ":8080" when
//     unset or empty.
//
// Returns an error only if a future loader step fails; the current
// implementation cannot fail.
func LoadEnvConfig() (Config, error) {
	var cfg Config
	cfg.Server.Address = os.Getenv("SERVER_ADDRESS")
	if cfg.Server.Address == "" {
		cfg.Server.Address = ":8080"
	}

	return cfg, nil
}
