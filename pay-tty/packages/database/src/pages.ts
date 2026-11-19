import { type SQL, sql } from "drizzle-orm"
import type { AnyPgColumn } from "drizzle-orm/pg-core"
import { DateTime, Effect, Encoding, Option, Schema } from "effect"

// Keyset pagination, newest first. Cursors encode the last row's creation
// timestamp and ID as base64url JSON.

// Validate the Postgres timestamp (including microseconds) before casting in
// SQL so malformed cursors fail as request errors rather than query defects.
const CursorAt = Schema.String.check(
  Schema.isPattern(/^(?!0000)\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?[+-](?:0\d|1[0-5])(?::[0-5]\d)?$/),
  Schema.makeFilter((at) => {
    const date = DateTime.make(at)
    const day = DateTime.make(at.slice(0, 10) + "T00:00:00Z")

    return Option.isSome(date) && Option.isSome(day) &&
      DateTime.formatIsoDate(day.value) === at.slice(0, 10)
  }),
)

/** Formats a timestamp column in UTC with microsecond precision, independent of DateStyle. */
export const cursorAt = (column: AnyPgColumn) =>
  sql<string>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00'`

export interface Position<Id> {
  readonly at: string
  readonly id: Id
}

/** Keyset cursor helpers for rows with IDs matching `id`. */
export const pages = <Id extends string>(id: Schema.Codec<Id, string>) => {
  const value = Schema.fromJsonString(Schema.Struct({ at: CursorAt, id }))

  return {
    /** Decodes a cursor into a row position. */
    decode: (cursor: string): Effect.Effect<Position<Id>, void> =>
      Effect.gen(function* () {
        const decoded = yield* Effect.fromResult(Encoding.decodeBase64UrlString(cursor))

        return yield* Schema.decodeEffect(value)(decoded)
      }).pipe(Effect.mapError(() => undefined)),

    /** Filters rows older than `position`, or returns undefined when `position` is null. */
    before: (createdAt: AnyPgColumn, rowId: AnyPgColumn, position: Position<Id> | null): SQL | undefined =>
      position === null ? undefined : sql`(${createdAt}, ${rowId}) < (${position.at}::timestamptz, ${position.id})`,

    /**
     * Slices `rows` (fetched with limit `size + 1`) to `size` and encodes the
     * next cursor, or null on the final page.
     */
    page: <Row>(rows: ReadonlyArray<Row>, size: number, position: (row: Row) => Position<Id>) =>
      Effect.gen(function* () {
        const shown = rows.slice(0, size)
        const last = shown.at(-1)

        if (rows.length <= size || last === undefined) {
          return { rows: shown, next: null }
        }

        const encoded = yield* Schema.encodeEffect(value)(position(last)).pipe(Effect.orDie)

        return { rows: shown, next: Encoding.encodeBase64Url(encoded) }
      }),
  }
}
