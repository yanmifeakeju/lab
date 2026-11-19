import { ago, fromNow } from "@pay-tty/database/columns"
import { and, asc, eq, inArray, isNull, lte, or, type SQL, sql } from "drizzle-orm"
import { Context, Duration, Effect, Layer, Predicate, Result } from "effect"

import { Database } from "../database/client.ts"
import { Ledger } from "../ledger/slug.ts"
import { ledgerPostings, ledgers } from "../ledger/sql.ts"
import { destinationOf, expiredMark, ID, lapsedDraft, Service as Payouts } from "./payouts.ts"
import { PayoutProvider } from "./provider.ts"
import { payouts } from "./sql.ts"

/** Payouts processed per batch in each dispatcher step. */
export const batchSize = 10

/** Per-call timeout for provider requests. */
export const providerTimeout = Duration.seconds(10)

// The status-check schedule for NIP transfers, which typically settle in
// seconds but can stay pending for hours. Unchecked against a real provider:
// its documented time to finality sets them.

/** From the send to the first status check. */
export const firstCheck = Duration.minutes(2)

/** Between checks while the provider answers pending or not received. */
export const pendingGaps = [Duration.minutes(2), Duration.minutes(5), Duration.minutes(10), Duration.minutes(30)]

/** Between checks once `pendingGaps` runs out. */
export const thenEvery = Duration.hours(1)

/** From the send to the last check, whose answer decides a payout still in flight. */
export const giveUpAfter = Duration.hours(24)

/**
 * Returns the offset from `sentAt` for the next status check after an answer
 * at `elapsed`, capped at `giveUpAfter`, or null once `giveUpAfter` has elapsed.
 */
const nextCheck = (elapsed: Duration.Duration): Duration.Duration | null => {
  if (Duration.isGreaterThanOrEqualTo(elapsed, giveUpAfter)) {
    return null
  }

  let at = firstCheck
  let step = 0

  while (Duration.isLessThanOrEqualTo(at, elapsed)) {
    at = Duration.sum(at, pendingGaps[step] ?? thenEvery)
    step += 1
  }

  return Duration.min(at, giveUpAfter)
}

/** Backoff before retrying a failed status check. */
export const recheckAfter = Duration.minutes(1)

/**
 * Maximum time a due status check may keep failing before the payout is
 * flagged for attention.
 */
export const settleGiveUpAfter = Duration.hours(1)

/**
 * Maximum time a confirmed payout's hold may remain unconfirmed after its
 * first relay attempt before the payout is flagged for attention.
 */
export const holdDeadline = Duration.minutes(5)

export interface Interface {
  /**
   * Runs one dispatcher pass:
   * - expires unconfirmed drafts past their TTL;
   * - flags requested payouts whose ledger hold has not been confirmed within `holdDeadline`;
   * - sends `held` payouts once;
   * - polls the provider for `sent` payouts past their check time, settling
   *   `paid`/`unpaid` outcomes, sending again those it never received,
   *   rescheduling `pending` transfers, and flagging `unknown` ones for
   *   attention. At the give-up, never received voids and pending is flagged.
   *   A payout the provider acknowledged with a ref is never "never received":
   *   it is flagged, never sent again or voided.
   * A send the provider refuses is flagged, with its hold kept.
   */
  readonly dispatch: Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("PayoutDispatcher") {}

const make = Effect.gen(function* () {
  const database = yield* Database
  const provider = yield* PayoutProvider.Service
  const service = yield* Payouts

  const claimed = {
    id: payouts.id,
    amount: payouts.amount,
    bankCode: payouts.bankCode,
    accountNumber: payouts.accountNumber,
    accountName: payouts.accountName,
    providerRef: payouts.providerRef,
    ledger: payouts.ledger,
    currency: ledgers.currency,
  }

  const transferOf = (row: {
    readonly id: string
    readonly amount: bigint
    readonly bankCode: string
    readonly accountNumber: string
    readonly accountName: string
    readonly providerRef: string | null
    readonly ledger: string
    readonly currency: string
  }) =>
    new PayoutProvider.Transfer({
      payoutId: ID.make(row.id),
      ledger: Ledger.Slug.make(row.ledger),
      currencyCode: row.currency,
      amount: row.amount,
      destination: destinationOf(row),
      providerRef: row.providerRef,
    })

  // Sends once. A send that errors or times out is left to the next check,
  // which sends again if the provider never received it; it never voids. A
  // refused one goes to attention.
  const send = (transfer: PayoutProvider.Transfer) =>
    Effect.gen(function* () {
      const sent = yield* Effect.result(provider.send(transfer).pipe(Effect.timeout(providerTimeout)))

      if (Result.isFailure(sent)) {
        if (Predicate.isTagged(sent.failure, "PayoutProvider.RefusedError")) {
          return yield* flag(transfer, `the provider refused it: ${sent.failure.message}`)
        }

        return yield* Effect.logWarning("payout send unanswered; the next check decides", sent.failure).pipe(
          Effect.annotateLogs({ payoutId: transfer.payoutId }),
        )
      }

      const kept = yield* database.use((db) =>
        db
          .update(payouts)
          .set({ providerRef: sql`coalesce(${payouts.providerRef}, ${sent.success})` })
          .where(eq(payouts.id, transfer.payoutId))
          .returning({ stored: payouts.providerRef }),
      )

      // The stored ref is never overwritten; another one means the provider may hold the payout twice.
      const stored = kept[0]?.stored

      if (stored !== undefined && stored !== null && stored !== sent.success) {
        // Logged even if a callback already settled it, which `flag` leaves alone.
        yield* Effect.logWarning("payout accepted under another provider ref than the stored one").pipe(
          Effect.annotateLogs({ payoutId: transfer.payoutId, storedRef: stored, acceptedRef: sent.success }),
        )

        return yield* flag(transfer, `the provider accepted it as ${sent.success}, but it was stored as ${stored}`)
      }
    }).pipe(
      // Isolate per-payout failures so one failing send does not abort the batch.
      Effect.catchDefect((defect) =>
        Effect.logError("payout send died; the next check decides", defect).pipe(
          Effect.annotateLogs({ payoutId: transfer.payoutId }),
        )),
      Effect.catchCause((cause) =>
        Effect.logError("payout send couldn't be recorded; the next check decides", cause).pipe(
          Effect.annotateLogs({ payoutId: transfer.payoutId }),
        )),
    )

  // Claims held payouts by marking them `sent`, with the first check due.
  const sendDue = Effect.gen(function* () {
    const due = yield* database.use((db) =>
      db
        .update(payouts)
        .set({ status: "sent", sentAt: sql`now()`, nextCheckAt: fromNow(firstCheck) })
        .from(ledgers)
        .where(and(
          eq(ledgers.slug, payouts.ledger),
          inArray(
            payouts.id,
            db
              .select({ id: payouts.id })
              .from(payouts)
              .where(eq(payouts.status, "held"))
              .orderBy(asc(payouts.createdAt))
              .limit(batchSize)
              .for("update", { skipLocked: true }),
          ),
        ))
        .returning(claimed),
    )

    yield* Effect.forEach(due.map(transferOf), send, {
      concurrency: batchSize,
      discard: true,
    })
  })

  // Transitions a `sent` payout to `attention` when `when` (if provided) holds.
  const flag = (transfer: PayoutProvider.Transfer, why: string, when?: SQL) =>
    Effect.gen(function* () {
      const flagged = yield* database.use((db) =>
        db
          .update(payouts)
          .set({ status: "attention" })
          .where(and(
            eq(payouts.id, transfer.payoutId),
            eq(payouts.status, "sent"),
            when,
          ))
          .returning({ id: payouts.id }),
      )

      if (flagged.length > 0) {
        yield* Effect.logWarning("payout the provider hasn't settled needs attention", why).pipe(
          Effect.annotateLogs({ payoutId: transfer.payoutId }),
        )
      }
    })

  // Records the failure, then flags the payout once checks have failed without
  // an answer for `settleGiveUpAfter`. Measured from the first failure, so time
  // spent pending or with plane down doesn't count.
  const failedCheck = (transfer: PayoutProvider.Transfer, why: string) =>
    database
      .use((db) =>
        db
          .update(payouts)
          .set({ checkFailingSince: sql`coalesce(${payouts.checkFailingSince}, now())` })
          .where(and(eq(payouts.id, transfer.payoutId), eq(payouts.status, "sent"))),
      )
      .pipe(Effect.andThen(flag(transfer, why, lte(payouts.checkFailingSince, ago(settleGiveUpAfter)))))

  // Schedules the next status check; the caller decides what the give-up means.
  const schedule = (transfer: PayoutProvider.Transfer, next: Duration.Duration) =>
    database.use((db) =>
      db
        .update(payouts)
        .set({
          nextCheckAt: sql`${payouts.sentAt} + make_interval(secs => ${Duration.toSeconds(next)})`,
          checkFailingSince: null,
        })
        .where(and(eq(payouts.id, transfer.payoutId), eq(payouts.status, "sent"))),
    )

  // Polls the provider to resolve an unreported transfer. Timeouts never void
  // a hold because the transfer may have succeeded; only an explicit `unpaid`
  // response voids. `unknown` flags the payout for attention immediately.
  const settle = (transfer: PayoutProvider.Transfer, elapsed: Duration.Duration) =>
    Effect.gen(function* () {
      const standing = yield* Effect.result(provider.standing(transfer).pipe(Effect.timeout(providerTimeout)))

      if (Result.isFailure(standing)) {
        return yield* Effect.logWarning("provider couldn't say whether it paid", standing.failure).pipe(
          Effect.annotateLogs({ payoutId: transfer.payoutId }),
          Effect.andThen(failedCheck(transfer, "the provider never answered")),
        )
      }

      const answer = standing.success

      if (answer.status === "unknown") {
        return yield* flag(transfer, answer.status)
      }

      // A provider that gave a ref took the payout, so it can't vouch it never
      // received it, whatever its lookup says now.
      if (answer.status === "not_received" && transfer.providerRef !== null) {
        return yield* flag(transfer, "not found after the provider acknowledged it")
      }

      const next = nextCheck(elapsed)

      if (answer.status === "pending") {
        return yield* next === null ? flag(transfer, "still pending at the give-up") : schedule(transfer, next)
      }

      // Never received, vouched for by the provider: nothing left, so sending
      // again is safe, and at the give-up the hold is released.
      if (answer.status === "not_received") {
        if (next === null) {
          return yield* service.report(transfer.payoutId, "failed", null)
        }

        yield* schedule(transfer, next)

        return yield* send(transfer)
      }

      yield* service.report(transfer.payoutId, answer.status === "paid" ? "paid" : "failed", answer.providerRef)
    }).pipe(
      // Isolate per-payout defects so one failing check does not block the batch.
      Effect.catchDefect((defect) =>
        Effect.logError("sent payout couldn't be settled", defect).pipe(
          Effect.annotateLogs({ payoutId: transfer.payoutId }),
          Effect.andThen(failedCheck(transfer, "settling kept failing")),
        )),
      Effect.catchCause((cause) =>
        Effect.logError("sent payout's check couldn't be recorded", cause).pipe(
          Effect.annotateLogs({ payoutId: transfer.payoutId }),
        )),
    )

  // Claims `sent` payouts due for a status check by stamping `settle_attempted_at`.
  // Unchecked payouts run before retries (`nulls first`).
  const settleLapsed = Effect.gen(function* () {
    const lapsed = yield* database.use((db) =>
      db
        .update(payouts)
        .set({ settleAttemptedAt: sql`now()` })
        .from(ledgers)
        .where(and(
          eq(ledgers.slug, payouts.ledger),
          inArray(
            payouts.id,
            db
              .select({ id: payouts.id })
              .from(payouts)
              .where(and(
                eq(payouts.status, "sent"),
                lte(payouts.nextCheckAt, sql`now()`),
                or(isNull(payouts.settleAttemptedAt), lte(payouts.settleAttemptedAt, ago(recheckAfter))),
              ))
              .orderBy(sql`${payouts.settleAttemptedAt} asc nulls first`, asc(payouts.sentAt))
              .limit(batchSize)
              .for("update", { skipLocked: true }),
          ),
        ))
        .returning({
          ...claimed,
          elapsed: sql<number>`extract(epoch from now() - ${payouts.sentAt})`.mapWith(Number),
        }),
    )

    yield* Effect.forEach(lapsed, (row) => settle(transferOf(row), Duration.seconds(row.elapsed)), {
      concurrency: batchSize,
      discard: true,
    })
  })

  // Marks lapsed drafts `expired` in the database so direct ID lookups and
  // stored records reflect expiry even if `confirm` is never called.
  const expireDrafts = database.use((db) =>
    db
      .update(payouts)
      .set(expiredMark)
      .where(
        inArray(
          payouts.id,
          db
            .select({ id: payouts.id })
            .from(payouts)
            .where(lapsedDraft)
            .orderBy(asc(payouts.expiresAt))
            .limit(batchSize)
            .for("update", { skipLocked: true }),
        ),
      ),
  )

  // Flags `requested` payouts whose hold posting has been attempted by the
  // relay (`first_attempt_at` is set) but remains unconfirmed past `holdDeadline`.
  // The relay continues retrying; a subsequent ledger refusal still moves the
  // payout from `attention` to `rejected`.
  const flagUnheld = Effect.gen(function* () {
    const flagged = yield* database.use((db) =>
      db
        .update(payouts)
        .set({ status: "attention" })
        .where(
          inArray(
            payouts.id,
            db
              .select({ id: payouts.id })
              .from(payouts)
              .innerJoin(ledgerPostings, eq(ledgerPostings.payoutId, payouts.id))
              .where(and(
                eq(payouts.status, "requested"),
                eq(ledgerPostings.state, "created"),
                lte(ledgerPostings.firstAttemptAt, ago(holdDeadline)),
              ))
              .orderBy(asc(ledgerPostings.firstAttemptAt))
              .limit(batchSize)
              .for("update", { of: payouts, skipLocked: true }),
          ),
        )
        .returning({ id: payouts.id }),
    )

    yield* Effect.forEach(flagged, ({ id }) =>
      Effect.logWarning("payout hold never confirmed; it needs attention").pipe(Effect.annotateLogs({ payoutId: id })), {
      discard: true,
    })
  })

  return Service.of({
    // Run each step sequentially and isolate failures so one failing step
    // does not prevent the others from running. In turn, not concurrently,
    // because the dispatcher shares the API's pool.
    dispatch: Effect.forEach(
      [
        ["expiring drafts", expireDrafts],
        ["flagging unheld", flagUnheld],
        ["sending", sendDue],
        ["settling", settleLapsed],
      ] as const,
      ([step, run]) =>
        run.pipe(Effect.asVoid, Effect.catchCause((cause) => Effect.logError(`payout ${step} died`, cause))),
      { discard: true },
    ).pipe(Effect.withSpan("PayoutDispatcher.dispatch")),
  })
})

export const layer = Layer.effect(Service)(make)

export * as PayoutDispatcher from "./dispatcher.ts"
