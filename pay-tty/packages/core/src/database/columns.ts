import { sql } from "drizzle-orm"
import { timestamp } from "drizzle-orm/pg-core"

// Exactly what JavaScript's String.prototype.trim() removes, so text core
// accepts as trimmed is text the database accepts. Postgres's own \s differs
// by locale.
export const space = String.raw`[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]`

export const createdAt = {
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .defaultNow()
    .notNull(),
}

// Drizzle sets updated_at on every update it issues; raw SQL must set it
// itself.
export const timestamps = {
  ...createdAt,
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
    .defaultNow()
    .notNull()
    .$onUpdate(() => sql`now()`),
}
