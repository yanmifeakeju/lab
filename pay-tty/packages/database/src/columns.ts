import { sql } from "drizzle-orm"
import { type AnyPgColumn, bigint, customType, timestamp } from "drizzle-orm/pg-core"
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

/**
 * Text compared byte for byte (`COLLATE "C"`): IDs, refs, keys and codes,
 * which are matched, never read. It keeps their order the one code sees, and
 * skips locale-aware comparison in their indexes. Use it on both sides of a
 * foreign key: Postgres accepts a plain `text` column referencing one, but
 * that column then compares by locale.
 */
export const identifier = customType<{ data: string; driverData: string }>({
  dataType: () => 'text COLLATE "C"',
})
