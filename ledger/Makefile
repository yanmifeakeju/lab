.PHONY: generate build build-api test test-integration test-integration-race test-race vet cover run start db-reset migrate-up migrate-status clean

DB_URL?=$$DATABASE_URL
API_BIN:=bin/ledger-api

generate:
	go generate ./...

build:
	go build ./...

build-api:
	mkdir -p $(dir $(API_BIN))
	go build -o $(API_BIN) ./cmd/api

test:
	go test ./...

test-integration:
	go test -tags=integration -count=1 ./internal/postgres

test-integration-race:
	go test -race -tags=integration -count=1 ./internal/postgres

test-race:
	go test -race ./...

vet:
	go vet ./...

cover:
	go test -coverprofile=coverage.out ./...
	go tool cover -func=coverage.out

run:
	go run ./cmd/api

start: build-api
	$(API_BIN)

db-reset:
	@set -eu; \
	if [ -z "$${DATABASE_URL:-}" ] && [ -f .env ]; then \
		set -a; . ./.env; set +a; \
	fi; \
	./scripts/database.sh --reset; \
	$(MAKE) migrate-up; \
	./scripts/seed.sh

migrate-up:
	DATABASE_URL="$(DB_URL)" go run ./cmd/migrate up

migrate-status:
	DATABASE_URL="$(DB_URL)" go run ./cmd/migrate status

clean:
	go clean -testcache
