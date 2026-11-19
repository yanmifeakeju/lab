import { sql } from "drizzle-orm"
import { type AnyPgColumn, bigint, timestamp } from "drizzle-orm/pg-core"
import { Duration } from "effect"

// Amounts are stored in minor units of the ledger's currency and scale.
export const amount = (name: string) => bigint(name, { mode: "bigint" })

// Capped at MAX_SAFE_INTEGER so amounts round-trip through JSON and JS numbers without loss.
export const maxAmount = BigInt(Number.MAX_SAFE_INTEGER)

export const amountValid = (column: AnyPgColumn) => sql`${column} between 1 and ${sql.raw(String(maxAmount))}`

export const at = (name: string) => timestamp(name, { withTimezone: true, mode: "date" })

// Relative timestamps evaluated against the database clock so all processes agree.
export const ago = (duration: Duration.Duration) => sql`now() - make_interval(secs => ${Duration.toSeconds(duration)})`

export const fromNow = (duration: Duration.Duration) =>
  sql`now() + make_interval(secs => ${Duration.toSeconds(duration)})`
