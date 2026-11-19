import { ago } from "@pay-tty/database/columns"
import { and, asc, eq, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm"
import { Duration, Effect, Schema } from "effect"
import { ulid } from "ulid"

import { SimDatabase } from "../database.ts"
import { decidedOutcome, providerPayouts } from "./sql.ts"

/** Transfers settled or reported per pass. */
export const batchSize = 100

/** A payout as the sender asks for it, keyed by its reference. */
export interface Payout {
  readonly reference: string
  readonly ledger: string
  readonly amount: bigint
  readonly bankCode: string
  readonly accountNumber: string
  readonly accountName: string
}

/** The reference was sent before with another amount, ledger or destination. */
export class ConflictError extends Schema.TaggedError<ConflictError>()("Sim.ConflictError", {
  reference: Schema.String,
}) {}

/** Accepts the payout once; a repeat with the same details returns the first ref. */
export const accept = (payout: Payout) =>
  Effect.gen(function* () {
    const database = yield* SimDatabase

    const inserted = yield* database.use((db) =>
      db
        .insert(providerPayouts)
        .values({ providerRef: `spo_${ulid()}`, ...payout })
        .onConflictDoNothing({ target: providerPayouts.reference })
        .returning({ providerRef: providerPayouts.providerRef }),
    )

    const first = inserted[0]

    if (first !== undefined) {
      return { providerRef: first.providerRef, created: true }
    }

    const rows = yield* database.use((db) =>
      db.select().from(providerPayouts).where(eq(providerPayouts.reference, payout.reference)),
    )

    const existing = rows[0] ?? (yield* Effect.die(new Error(`payout ${payout.reference} conflicted but isn't stored`)))

    const same = existing.ledger === payout.ledger && existing.amount === payout.amount &&
      existing.bankCode === payout.bankCode && existing.accountNumber === payout.accountNumber &&
      existing.accountName === payout.accountName

    if (!same) {
      return yield* new ConflictError({ reference: payout.reference })
    }

    return { providerRef: existing.providerRef, created: false }
  })

/**
 * The transfer's status by reference, finalised first if `delay` has passed,
 * or undefined with no record. The row stays locked meanwhile, so the
 * reporter, which skips locked rows, can't commit an outcome this misses.
 */
export const lookup = (reference: string, delay: Duration.Duration) =>
  Effect.gen(function* () {
    const database = yield* SimDatabase

    return yield* database.transaction(
      Effect.gen(function* () {
        const rows = yield* database.use((db) =>
          db
            .select({
              providerRef: providerPayouts.providerRef,
              outcome: providerPayouts.outcome,
              due: sql<boolean>`${providerPayouts.sentAt} <= ${ago(delay)}`,
            })
            .from(providerPayouts)
            .where(eq(providerPayouts.reference, reference))
            .for("update"),
        )

        const row = rows[0]

        if (row === undefined) {
          return undefined
        }

        if (row.outcome !== null || !row.due) {
          return { status: row.outcome ?? ("pending" as const), providerRef: row.providerRef }
        }

        const settled = yield* database.use((db) =>
          db
            .update(providerPayouts)
            .set({ outcome: decidedOutcome })
            .where(eq(providerPayouts.reference, reference))
            .returning({ outcome: providerPayouts.outcome }),
        )

        return { status: settled[0]?.outcome ?? ("pending" as const), providerRef: row.providerRef }
      }),
    )
  })

/** Finalises the transfers whose `delay` has passed. */
export const settleDue = (delay: Duration.Duration) =>
  Effect.gen(function* () {
    const database = yield* SimDatabase

    yield* database.use((db) =>
      db
        .update(providerPayouts)
        .set({ outcome: decidedOutcome })
        .where(
          inArray(
            providerPayouts.providerRef,
            db
              .select({ providerRef: providerPayouts.providerRef })
              .from(providerPayouts)
              .where(and(isNull(providerPayouts.outcome), lte(providerPayouts.sentAt, ago(delay))))
              .orderBy(asc(providerPayouts.sentAt))
              .limit(batchSize)
              .for("update", { skipLocked: true }),
          ),
        ),
    )
  })

/** Final outcomes whose callback is due: unacknowledged, not given up, and past any retry wait. Oldest first. */
export const unreported = Effect.gen(function* () {
  const database = yield* SimDatabase

  return yield* database.use((db) =>
    db
      .select({
        reference: providerPayouts.reference,
        providerRef: providerPayouts.providerRef,
        outcome: sql<"paid" | "failed">`${providerPayouts.outcome}`,
      })
      .from(providerPayouts)
      .where(and(
        isNotNull(providerPayouts.outcome),
        isNull(providerPayouts.reportedAt),
        isNull(providerPayouts.callbackAbandonedAt),
        sql`(${providerPayouts.nextCallbackAt} is null or ${providerPayouts.nextCallbackAt} <= now())`,
      ))
      .orderBy(asc(providerPayouts.sentAt))
      .limit(batchSize),
  )
})

export const markReported = (providerRef: string) =>
  Effect.gen(function* () {
    const database = yield* SimDatabase

    yield* database.use((db) =>
      db.update(providerPayouts).set({ reportedAt: sql`now()` }).where(eq(providerPayouts.providerRef, providerRef)),
    )
  })

/** How a failed callback is retried. */
export interface Retry {
  /** The wait after the first failure; it doubles after each one. */
  readonly first: Duration.Duration
  /** Attempts before the callback is given up. */
  readonly attempts: number
}

/**
 * Records a failed callback (`status` null for no answer): waits before the
 * next attempt, or gives up after the last one. Returns whether it gave up.
 */
export const callbackFailed = (providerRef: string, status: number | null, retry: Retry) =>
  Effect.gen(function* () {
    const database = yield* SimDatabase

    const rows = yield* database.use((db) =>
      db
        .update(providerPayouts)
        .set({
          callbackAttempts: sql`${providerPayouts.callbackAttempts} + 1`,
          callbackStatus: status,
          nextCallbackAt: sql`now() + make_interval(secs => ${Duration.toSeconds(retry.first)} * power(2, ${providerPayouts.callbackAttempts}))`,
          callbackAbandonedAt: sql`case when ${providerPayouts.callbackAttempts} + 1 >= ${retry.attempts} then now() end`,
        })
        .where(eq(providerPayouts.providerRef, providerRef))
        .returning({
          attempts: providerPayouts.callbackAttempts,
          nextAt: providerPayouts.nextCallbackAt,
          abandonedAt: providerPayouts.callbackAbandonedAt,
        }),
    )

    const row = rows[0]

    return { attempts: row?.attempts ?? 0, nextAt: row?.nextAt ?? null, abandoned: row?.abandonedAt != null }
  })

/** Gives up a callback at once, as for a row that can't be encoded. */
export const abandonCallback = (providerRef: string) =>
  Effect.gen(function* () {
    const database = yield* SimDatabase

    yield* database.use((db) =>
      db.update(providerPayouts).set({ callbackAbandonedAt: sql`now()` }).where(eq(providerPayouts.providerRef, providerRef)),
    )
  })

export * as Store from "./store.ts"
