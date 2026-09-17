package database

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
)

// Open returns a [*sql.DB] for the given DSN. The caller owns its lifetime.
// Use Close() on shutdown.
func Open(ctx context.Context, dsn string) (*sql.DB, error) {
	connConfig, err := pgx.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("parse dsn: %w", err)
	}
	if connConfig.RuntimeParams == nil {
		connConfig.RuntimeParams = make(map[string]string)
	}
	connConfig.RuntimeParams["timezone"] = "UTC"
	// Statements end statement.Margin before the database clock, which is
	// safe only while no posting transaction outlives that margin. These cap
	// a posting at one statement plus one idle wait before commit.
	connConfig.RuntimeParams["statement_timeout"] = "30s"
	connConfig.RuntimeParams["idle_in_transaction_session_timeout"] = "30s"

	db := stdlib.OpenDB(*connConfig)

	db.SetMaxOpenConns(25)
	db.SetMaxIdleConns(25)
	db.SetConnMaxLifetime(5 * time.Minute)

	if err := db.PingContext(ctx); err != nil {
		db.Close()
		return nil, fmt.Errorf("ping db: %w", err)
	}

	return db, nil
}
