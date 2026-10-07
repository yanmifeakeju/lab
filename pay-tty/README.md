# pay-tty

Effect 4, TypeScript 7, pnpm, and Turborepo monorepo for applications and
shared packages.

## Workspace layout

- `apps/` — deployable and runnable applications
- `apps/plane/` — issues session tokens (`POST /session`), returns the caller and its business (`GET /me`), and creates businesses (`POST /business`)
- `apps/control-plane/` — the implementation plane was split from, kept as reference until it is deleted
- `packages/` — reusable workspace packages
- `packages/core/` — domain database schema, migrations, and the principal, business, and ledger services
- `packages/ledger-client/` — generated Effect client for the ledger API
- `ledger/` — the existing Go ledger service
- `openapi.yaml` — the repository-level HTTP API contract

## Getting started

```sh
pnpm install
pnpm generate:client
pnpm dev
pnpm start
pnpm typecheck
pnpm lint
pnpm test
```

The shared package describes computations as `Effect` values. The application
entry point composes and executes them, keeping runtime execution at the edge.

`pnpm typecheck` uses the TypeScript 7 native compiler patched with the Effect
language service. Strict TypeScript settings apply to source and test files, and
VS Code-based editors are configured to use the same workspace compiler.

`pnpm lint` runs type-aware Oxlint through the Effect TSGO integration. Effect
diagnostics are disabled in the editor plugin to prevent duplicate reports;
Oxlint is the single reporting path for those diagnostics. The official Oxc
extension is recommended for VS Code-based editors, with safe fixes enabled on
save. Anti-slop treats the `@pay-tty/` workspace namespace as project-local, so
Effect service-constructor boundaries are enforced across packages as well as
through relative imports.

Root commands use Turborepo to schedule tasks and cache successful results. Run a
command in one workspace package with a filter:

```sh
pnpm turbo run start --filter=@pay-tty/app
pnpm turbo run typecheck --filter=@pay-tty/ledger-client
```

Add another workspace package by creating a directory under `apps/` or
`packages/` with its own `package.json`.
