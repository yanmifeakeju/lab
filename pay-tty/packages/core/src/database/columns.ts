import { at } from "@pay-tty/database/columns"
import { sql } from "drizzle-orm"
import type { AnyPgColumn } from "drizzle-orm/pg-core"

// Matches JavaScript's `String.prototype.trim()` whitespace set so application
// and database trim checks agree across locales.
export const space = String.raw`[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]`

export const createdAt = {
  createdAt: at("created_at").defaultNow().notNull(),
}

// Drizzle updates `updated_at` on ORM writes; raw SQL updates must set it explicitly.
export const timestamps = {
  ...createdAt,
  updatedAt: at("updated_at").defaultNow().notNull().$onUpdate(() => sql`now()`),
}

export const idempotencyKeyValid = (column: AnyPgColumn) => sql`${column} ~ '^[!-~]{1,255}$'`

export const trimmed = (column: AnyPgColumn) => sql`${column} !~ ${sql.raw(`'^${space}|${space}$'`)}`

// SQL equivalent of `isOneLine` (`common/schemas.ts`), expanding `\p{Cc}`
// explicitly (Postgres regexes lack Unicode property classes and `text` forbids NUL).
export const oneLine = (column: AnyPgColumn) =>
  sql`${column} !~ ${sql.raw(String.raw`'[\u0001-\u001f\u007f-\u009f\u2028\u2029]'`)}`
