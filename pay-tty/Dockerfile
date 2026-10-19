# syntax=docker/dockerfile:1

# The TypeScript workspace: plane, the TUI, and the setup job that migrates
# and seeds. Each is a target: docker build --target plane .

FROM node:26-slim AS pnpm

RUN npm install --global pnpm@11.24.0

WORKDIR /app

# Only the lockfile, so the download layer survives source changes. The
# store is all that's kept: fetch also links every package into
# node_modules, which each install below would otherwise inherit.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch && rm -rf node_modules

COPY . .

# Scripts are skipped: the root's `prepare` patches dev tooling, and the
# workspace already refuses dependency build scripts.
FROM pnpm AS plane-deps
RUN pnpm install --offline --frozen-lockfile --prod --ignore-scripts --filter @pay-tty/plane...

FROM pnpm AS tui-deps
RUN pnpm install --offline --frozen-lockfile --prod --ignore-scripts --filter @pay-tty/tui...

# drizzle-kit is a dev dependency of core, so this one keeps dev dependencies.
FROM pnpm AS setup-deps
RUN pnpm install --offline --frozen-lockfile --ignore-scripts --filter @pay-tty/core

FROM node:26-slim AS plane

ENV NODE_ENV=production
WORKDIR /app
COPY --from=plane-deps /app ./
USER node

EXPOSE 3000

# Node strips the types itself; workspace packages resolve through symlinks
# outside node_modules, where it is allowed to.
CMD ["node", "apps/plane/bin/api.ts"]

FROM oven/bun:1.4.2-slim AS tui

WORKDIR /app
COPY --from=tui-deps /app ./

# The host key lives on a volume; a new volume takes this directory's owner.
RUN mkdir /data && chown bun:bun /data
USER bun

# bunfig.toml, which preloads the Solid compiler, is read from here.
WORKDIR /app/apps/tui

EXPOSE 2222

CMD ["bun", "bin/server.tsx"]

FROM node:26-slim AS setup

RUN apt-get update \
	&& apt-get install --yes --no-install-recommends postgresql-client \
	&& rm -rf /var/lib/apt/lists/*

RUN npm install --global pnpm@11.24.0

WORKDIR /app
COPY --from=setup-deps /app ./
USER node

CMD ["deploy/setup.sh"]
