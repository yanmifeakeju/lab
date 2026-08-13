// Command migrate applies embedded SQL migrations to the ledger database.
//
// Usage:
//
//	DATABASE_URL="postgres://user:pass@host/db?sslmode=disable" migrate up
//	DATABASE_URL=... migrate status
package main

import (
	"database/sql"
	"flag"
	"fmt"
	"log"
	"os"

	"github.com/pressly/goose/v3"

	_ "github.com/lib/pq"

	"yanmifeakeju.com/ledger/migrations"
)

func main() {
	flag.Usage = func() {
		fmt.Fprintln(flag.CommandLine.Output(), "usage: migrate <up|status> [-flags]")
		flag.PrintDefaults()
	}
	flag.Parse()

	cmd := flag.Arg(0)
	if cmd == "" {
		flag.Usage()
		os.Exit(2)
	}

	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		log.Fatal("DATABASE_URL not set")
	}

	db, err := sql.Open("postgres", dsn)
	if err != nil {
		log.Fatalf("open db: %v", err)
	}
	defer db.Close()

	goose.SetBaseFS(migrations.Files)
	if err := goose.SetDialect("postgres"); err != nil {
		log.Fatalf("set dialect: %v", err)
	}

	switch cmd {
	case "up":
		if err := goose.Up(db, "."); err != nil {
			log.Fatalf("up: %v", err)
		}
	case "status":
		if err := goose.Status(db, "."); err != nil {
			log.Fatalf("status: %v", err)
		}
	default:
		log.Fatalf("unknown command %q (want up|status)", cmd)
	}
}
