import { Schema } from "effect"

export { maxAmount } from "@pay-tty/database/columns"

// Shared domain validators. Their SQL counterparts (`idempotencyKeyValid` and
// `oneLine` in `database/columns.ts`) must enforce identical constraints.

/**
 * Caller-supplied idempotency key. Restricted to printable non-whitespace
 * ASCII so it round-trips through HTTP headers unchanged.
 */
export const IdempotencyKey = Schema.String.check(
  Schema.isPattern(/^[!-~]{1,255}$/).annotate({ expected: "1 to 255 printable ASCII characters without spaces" }),
).pipe(Schema.brand("IdempotencyKey"))

export type IdempotencyKey = typeof IdempotencyKey.Type

/**
 * Single-line string filter. Rejects control characters and Unicode
 * line/paragraph separators.
 */
export const isOneLine = Schema.isPattern(/^[^\p{Cc}\u2028\u2029]*$/u).annotate({
  expected: "a single line without control characters",
})

export * as Common from "./schemas.ts"
