# syntax=docker/dockerfile:1

# Built from the repository root: docker build -f ledger/Dockerfile .
FROM golang:1.26 AS build

WORKDIR /src

COPY ledger/go.mod ledger/go.sum ./
RUN go mod download

COPY ledger/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/ledger-api ./cmd/api \
	&& CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/ledger-migrate ./cmd/migrate

# The migrations are embedded, so ledger-migrate needs nothing beside it.
FROM gcr.io/distroless/static-debian12:nonroot

COPY --from=build /out/ /usr/local/bin/

EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/ledger-api"]
