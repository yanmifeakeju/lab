//go:build integration

package postgres_test

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"os"
	"testing"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"

	"yanmifeakeju.com/ledger/migrations"
)

var testDB *sql.DB

// TODO: Test the store using a restricted runtime database role that has only
// CONNECT, schema USAGE, and EXECUTE privileges on public API routines.
func TestMain(m *testing.M) {
	os.Exit(runIntegrationTests(m))
}

func runIntegrationTests(m *testing.M) (code int) {
	setupCtx, cancelSetup := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancelSetup()

	container, err := tcpostgres.Run(
		setupCtx,
		"postgres:16-alpine",
		tcpostgres.WithDatabase("ledger_test"),
		tcpostgres.WithUsername("test"),
		tcpostgres.WithPassword("test"),
		tcpostgres.BasicWaitStrategies(),
	)
	if err != nil {
		log.Printf("start postgres container: %v", err)
		return 1
	}
	defer func() {
		cleanupCtx, cancelCleanup := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancelCleanup()

		if err := container.Terminate(cleanupCtx); err != nil {
			log.Printf("terminate postgres container: %v", err)
			if code == 0 {
				code = 1
			}
		}
	}()

	dsn, err := container.ConnectionString(setupCtx, "sslmode=disable")
	if err != nil {
		log.Printf("get postgres connection string: %v", err)
		return 1
	}

	testDB, err = sql.Open("pgx", dsn)
	if err != nil {
		log.Printf("open postgres: %v", err)
		return 1
	}
	defer func() {
		if err := testDB.Close(); err != nil {
			log.Printf("close postgres: %v", err)
			if code == 0 {
				code = 1
			}
		}
	}()

	if err := testDB.PingContext(setupCtx); err != nil {
		log.Printf("ping postgres: %v", err)
		return 1
	}

	goose.SetBaseFS(migrations.Files)
	if err := goose.SetDialect("postgres"); err != nil {
		log.Printf("set migration dialect: %v", err)
		return 1
	}
	if err := goose.Up(testDB, "."); err != nil {
		log.Printf("apply migrations: %v", err)
		return 1
	}

	return m.Run()
}

func newTestTx(t *testing.T) *sql.Tx {
	t.Helper()

	// The cleanup owns the transaction lifetime. Using t.Context here would
	// race database/sql's automatic rollback when testing cancels that context
	// immediately before running cleanup functions.
	tx, err := testDB.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatalf("begin test transaction: %v", err)
	}
	t.Cleanup(func() {
		if err := tx.Rollback(); err != nil && !errors.Is(err, sql.ErrTxDone) {
			t.Errorf("rollback test transaction: %v", err)
		}
	})

	return tx
}

func runWithRollbackSavepoint(t *testing.T, tx *sql.Tx, fn func() error) error {
	t.Helper()

	savepoint := "test_attempt"
	ctx := t.Context()

	if _, err := tx.ExecContext(ctx, "SAVEPOINT "+savepoint); err != nil {
		t.Fatalf("create savepoint: %v", err)
	}

	fnErr := fn()
	if _, err := tx.ExecContext(ctx, "ROLLBACK TO SAVEPOINT "+savepoint); err != nil {
		t.Fatalf("rollback to savepoint: %v", err)
	}

	if _, err := tx.ExecContext(ctx, "RELEASE SAVEPOINT "+savepoint); err != nil {
		t.Fatalf("release savepoint: %v", err)
	}

	return fnErr
}
