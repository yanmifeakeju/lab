// Package migrations embeds the ledger's SQL migration files
package migrations

import "embed"

// Files holds the embed migration sql
//
//go:embed *.sql
var Files embed.FS
