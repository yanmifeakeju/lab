# pay-tty

Effect 4, TypeScript 7, pnpm, and Turborepo monorepo for pay-tty's services and
shared packages. The SSH/TUI front end is not built yet; the backend it will
talk to is `apps/plane`.

## Workspace layout

- `apps/plane/` — plane, the HTTP service the front end calls: session tokens,
  the caller's business, and opening that business's ledger account
- `packages/core/` — plane's database schema and migrations, and the principal,
  business, and ledger catalog services
- `packages/ledger-client/` — generated Effect client for the ledger API
- `ledger/` — the Go ledger service, with its own database
- `openapi.yaml` — the ledger's HTTP API contract, which `ledger-client` is
  generated from. Plane publishes its own contract at `GET /openapi.json`.

## Plane's API

`/me` and the business routes take `Authorization: Bearer <token>`; `/health`,
`/openapi.json`, and the docs page are public.

- `POST /session` — exchanges an identity a trusted gateway verified,
  `{"issuer":"ssh","sub":"<key fingerprint>"}`, for a 15-minute access token.
  It is not for end users: only gateways should be able to reach it.
- `GET /me` — the caller's principal, and its business or `null`.
- `POST /business` — creates the caller's business from
  `{"name":"…","country_code":"NG"}`. `country_code` is `NG` or `US` and
  defaults to `NG` when omitted; plane derives the currency from it (`NG` →
  NGN, `US` → USD) and saves the country's default catalog ledger as the
  business's primary ledger. The business starts `created`. Repeating it
  returns the same business unchanged; one with a different name or country
  gets a 409 `conflict`. Only `NG`
  has a ledger today: a `US` business gets a 503 `country_unavailable` and
  nothing is created.
- `POST /business/:businessId/ledger` — opens the business's payable account
  in its saved primary ledger, records it on the business, and makes the
  business `active`. No body. Repeating it returns the business unchanged.

A business is `created` until its ledger account is recorded, then `active`;
there are no other states. A failed ledger call is an error response and
leaves the business `created`, ready to retry.

## Getting started

Needs Node 24, pnpm, a local PostgreSQL, `psql`, and Go for the ledger.

```sh
pnpm install
```

### Plane's database

`packages/core/.env` and `apps/plane/.env` must name the same database; copy
each package's `.env.example` and adjust `DATABASE_URL`. Then create, migrate,
and seed it:

```sh
pnpm --filter @pay-tty/core db:reset   # drops and recreates DATABASE_URL's database
```

`db:reset` refuses anything but a local database. On an existing database, use
`db:migrate` and then `db:seed` instead; migrations are rewritten before
launch, so a database migrated before a rewrite needs `db:reset`. The seed adds
`ngn_ng` as Nigeria's default catalog ledger, with its platform account refs.

### Plane's configuration

In `apps/plane/.env`, set signing keys that persist across restarts, or every
token issued before a restart stops verifying:

```sh
pnpm --filter @pay-tty/plane token:key   # prints a secret
```

```sh
PLANE_TOKEN_KEYS=local:<that secret>
PLANE_TOKEN_SIGNING_KEY_ID=local
LEDGER_BASE_URL=http://localhost:8080
```

### The ledger

Only `POST /business/:businessId/ledger` needs it. The ledger has its own
`DATABASE_URL` in `ledger/.env`, separate from plane's:

```sh
cd ledger
make db-reset   # recreates, migrates, and seeds the ledger's database
make run        # listens on :8080 unless SERVER_ADDRESS says otherwise
```

Both seeds derive the `ngn_ng` platform account refs the same way, so they
agree on a fresh setup. Plane's catalog mirrors each ledger's slug, currency,
and scale by hand; which ledger is a country's default is plane's alone, set
by its seed, and moving it only affects businesses created afterwards.

### Run plane

```sh
pnpm dev     # plane with --watch
pnpm start   # plane
```

A local session, from token to active business:

```sh
token=$(curl -s localhost:3000/session -H 'content-type: application/json' \
  -d '{"issuer":"ssh","sub":"SHA256:local"}' | jq -r .accessToken)

curl -s localhost:3000/me -H "authorization: Bearer $token"

business=$(curl -s localhost:3000/business -H "authorization: Bearer $token" \
  -H 'content-type: application/json' -d '{"name":"Acme Ltd"}' | jq -r .id)

curl -s -X POST "localhost:3000/business/$business/ledger" -H "authorization: Bearer $token"
```

## Checks

```sh
pnpm check   # generated-client diff, typecheck, lint
pnpm test    # anti-slop rule tests, then every package's tests
```

Core and plane tests need `DATABASE_URL` pointing at a local server: each run
creates a throwaway database there, migrates and seeds it, and drops it after.
The database named in the URL is never touched.

`pnpm typecheck` uses the TypeScript 7 native compiler, patched with the Effect
language service. Strict settings in the root `tsconfig.json` apply to source
and test files; the language service's own diagnostics are turned off there,
so they are reported once, through lint.

`pnpm lint` runs type-aware Oxlint with the Effect TSGO presets and the
vendored anti-slop plugins in `tools/oxlint/anti-slop/`, configured in
`.oxlintrc.json`. Anti-slop treats the `@pay-tty/` namespace as project-local,
so Effect service-constructor boundaries are enforced across packages as well
as through relative imports.

Root commands use Turborepo to schedule tasks and cache successful results. Run
a command in one package with a filter:

```sh
pnpm turbo run test --filter=@pay-tty/core
pnpm turbo run typecheck --filter=@pay-tty/plane
pnpm turbo run typecheck --filter=@pay-tty/ledger-client
```

Add a workspace package by creating a directory under `apps/` or `packages/`
with its own `package.json`.
