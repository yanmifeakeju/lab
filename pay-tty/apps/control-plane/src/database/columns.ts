import { sql } from "drizzle-orm"
import { timestamp } from "drizzle-orm/pg-core"

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
