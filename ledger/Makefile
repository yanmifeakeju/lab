.PHONY: generate build build-api test test-race vet cover run start migrate-up migrate-status clean

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

migrate-up:
	DATABASE_URL="$(DB_URL)" go run ./cmd/migrate up

migrate-status:
	DATABASE_URL="$(DB_URL)" go run ./cmd/migrate status

clean:
	go clean -testcache
