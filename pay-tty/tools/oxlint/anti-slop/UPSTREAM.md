# Upstream provenance

- Source repository: <https://github.com/dmmulroy/anti-slop>
- Source revision: unknown. The installed skill lock does not record an
  immutable commit, so no revision is inferred from the current upstream HEAD.
- Recoverable pristine snapshot:
  `.agents/skills/install-anti-slop/assets/anti-slop/`
- Skill bundle identity (`skills-lock.json` computed hash):
  `4031728fbe75bdcad6ee3208fd52b5d66e167b056fefee1fa9758e9a6cb9c0c8`

## Installed paths

- Generic plugin: `tools/oxlint/anti-slop/index.ts`
- Effect plugin: `tools/oxlint/anti-slop/effect/index.ts`
- Vendored ESLint Stylistic compatibility code:
  `tools/oxlint/anti-slop/vendor/eslint-stylistic/`

The nested ESLint Stylistic source retains its own `LICENSE` and `UPSTREAM.md`.

## Intentional deviations

Project policy is held in the root `.oxlintrc.json`: all bundled generic and
Effect rules are errors, agent tooling and this vendored directory are ignored,
and `@oxlint/plugins` is pinned to the same version as Oxlint (`1.82.0`).

The local `no-service-constructor-imports` rule adds a configurable
`internalImportPrefixes` option. The project config supplies `@pay-tty/`, so
workspace package imports receive the same enforcement as relative imports.
Relative imports and the upstream test/spec exemption are preserved. Focused
regression tests live beside the rule and run through `pnpm test`.

This is an intentional local extension against the recoverable pristine
snapshot above; no incoming upstream update was merged, and the upstream base
revision remains unknown.

## Local verification

Verified on 2026-09-22 with a strict standalone TypeScript compile of the
modified rule, direct rule tests, an Oxlint CLI acceptance/rejection test,
`pnpm lint`, `pnpm typecheck`, and `pnpm test`. Turbo tracks this directory and
the root Oxlint configuration as global dependencies so policy changes
invalidate cached lint results.
