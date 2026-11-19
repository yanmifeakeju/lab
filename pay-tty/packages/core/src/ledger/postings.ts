import { and, asc, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm"
import type { PgUpdateSetSource } from "drizzle-orm/pg-core"
import { EntryState } from "@pay-tty/ledger-client"
import { Array as Arr, Cause, Context, DateTime, Duration, Effect, Exit, Layer, Option, Order, Result, Schema } from "effect"

import { Database } from "../database/client.ts"
import { fromNow } from "@pay-tty/database/columns"
import { createId } from "../database/ids.ts"
import { payouts } from "../payouts/sql.ts"
import { LedgerClient } from "./client.ts"
import { Ledger } from "./slug.ts"
import { ledgerPostings, postingStates, resolutions } from "./sql.ts"

/** Maximum postings claimed per relay pass. */
export const relayBatchSize = 10

/** Per-request timeout for ledger calls; past it, the ledger counts as down. */
export const sendTimeout = Duration.seconds(5)

/**
 * Lease duration for a claimed batch (`2 * relayBatchSize * sendTimeout`),
 * sized so a pass that times out on every item still finishes before its lease expires.
 */
export const claimLease = Duration.times(sendTimeout, relayBatchSize * 2)

export const ID = Schema.String.pipe(
  Schema.check(Schema.isStartsWith("lpost_")),
  Schema.brand("LedgerPostings.ID"),
)

export type ID = typeof ID.Type

export const State = Schema.Literals(postingStates)

export type State = typeof State.Type

export const Resolution = Schema.Literals(resolutions)

export type Resolution = typeof Resolution.Type

/** Journal line payload with `amount` encoded as a decimal integer string. */
export class Line extends Schema.Class<Line>("LedgerPostings.Line")({
  debit_account_ref: Schema.String,
  credit_account_ref: Schema.String,
  amount: Schema.String,
  purpose: Schema.String,
}) {}

/** Claimed outbox posting ready to be sent or resolved in the ledger. */
export class Posting extends Schema.Class<Posting>("LedgerPostings.Posting")({
  id: ID,
  ledger: Ledger.Slug,
  /** Associated payout ID when this posting is a payout hold, or null for payments. */
  payoutId: Schema.NullOr(Schema.String),
  kind: Schema.String,
  description: Schema.String,
  lines: Schema.Array(Line),
  pending: Schema.Boolean,
  /** State when claimed: `created` to post the entry, or `pending` to resolve the hold. */
  state: Schema.Literals(postingStates),
  /** Ledger reference of the recorded entry, set once `state` leaves `created`. */
  journalRef: Schema.NullOr(Schema.String),
  resolution: Schema.NullOr(Resolution),
}) {}

// Maps ledger authorization states to `ledger_postings.state`.
const resolvedStates: Partial<Record<EntryState, "posted" | "voided">> = { captured: "posted", voided: "voided" }

export const postingOf = (row: typeof ledgerPostings.$inferSelect) =>
  new Posting({
    id: ID.make(row.id),
    ledger: Ledger.Slug.make(row.ledger),
    payoutId: row.payoutId,
    kind: row.kind,
    description: row.description,
    lines: row.lines.map((line) => new Line(line)),
    pending: row.pending,
    state: row.state,
    journalRef: row.journalRef,
    resolution: row.resolution,
  })

export const ClaimID = Schema.String.pipe(
  Schema.check(Schema.isStartsWith("lclaim_")),
  Schema.brand("LedgerPostings.ClaimID"),
)

export type ClaimID = typeof ClaimID.Type

/** Batch of postings leased to a single relay pass, ordered oldest first. */
export class Claim extends Schema.Class<Claim>("LedgerPostings.Claim")({
  id: ClaimID,
  postings: Schema.Array(Posting),
}) {}

/**
 * Result of sending a single posting. Both newly recorded holds and captured
 * holds return `posted`; voided holds return `voided`.
 */
export type Outcome = "posted" | "voided" | "refused" | "retrying" | "skipped"

/** The ledger was unreachable or returned an invalid/5xx response. */
export class UnavailableError extends Schema.TaggedError<UnavailableError>()(
  "LedgerPostings.UnavailableError",
  {},
) {}

export interface Interface {
  /**
   * Leases up to `limit` unleased postings (`state = 'created'` or `state =
   * 'pending'` with a `resolution`), ordered oldest first, and commits the
   * lease immediately. A pass that dies holding a lease leaves its postings
   * to the next claim once the lease expires.
   */
  readonly claim: (limit: number) => Effect.Effect<Claim>
  /**
   * Sends a claimed posting or resolution to the ledger and commits the result
   * if `claim` still owns the row. Permanent rejections mark the row `refused`;
   * transient failures increment `attempts` and return `retrying`.
   */
  readonly send: (claim: ClaimID, posting: Posting) => Effect.Effect<Outcome>
  /**
   * Claims a batch and sends each posting sequentially, aborting the pass on
   * the first transient failure (`retrying`) and releasing any remaining leases.
   */
  readonly relay: Effect.Effect<void, UnavailableError>
}

export class Service extends Context.Service<Service, Interface>()("LedgerPostings") {}

const make = Effect.gen(function* () {
  const database = yield* Database
  const client = yield* LedgerClient.Service

  const oldestFirst = Order.combine(
    Order.mapInput(Order.Date, (row: typeof ledgerPostings.$inferSelect) => row.createdAt),
    Order.mapInput(Order.String, (row: typeof ledgerPostings.$inferSelect) => row.id),
  )

  // Leases are evaluated against the database clock (`now()`).
  // The `OR` condition spans `ledger_postings_created_idx` and `ledger_postings_resolving_idx`,
  // so Postgres sorts every eligible row to take `limit`: cheap while the queue
  // is short. If an outage could back it up into tens of thousands, one partial
  // index on (created_at, id) where the whole OR holds would read in order.
  const claim = Effect.fn("LedgerPostings.claim")(function* (limit: number) {
    const id = ClaimID.make(createId("lclaim"))

    const rows = yield* database.use((db) =>
      db
        .update(ledgerPostings)
        .set({
          claimId: id,
          claimedUntil: fromNow(claimLease),
        })
        .where(
          inArray(
            ledgerPostings.id,
            db
              .select({ id: ledgerPostings.id })
              .from(ledgerPostings)
              .where(
                and(
                  or(
                    eq(ledgerPostings.state, "created"),
                    and(eq(ledgerPostings.state, "pending"), isNotNull(ledgerPostings.resolution)),
                  ),
                  or(isNull(ledgerPostings.claimedUntil), lte(ledgerPostings.claimedUntil, sql`now()`)),
                ),
              )
              .orderBy(asc(ledgerPostings.createdAt), asc(ledgerPostings.id))
              .limit(limit)
              .for("update", { skipLocked: true }),
          ),
        )
        .returning(),
    )

    return new Claim({
      id,
      // `UPDATE ... RETURNING` does not preserve the subquery's `ORDER BY`.
      postings: Arr.sort(rows, oldestFirst).map(postingOf),
    })
  })

  // Commits a state transition fenced by `(id, state, claim_id)`. When `payout`
  // is provided, updates the associated `payouts` row in the same statement via CTE.
  const commit = (
    claim: ClaimID,
    posting: Posting,
    outcome: Outcome,
    values: Partial<typeof ledgerPostings.$inferInsert>,
    payout?: PgUpdateSetSource<typeof payouts>,
    from: ReadonlyArray<"requested" | "attention"> = ["requested"],
  ) =>
    Effect.gen(function* () {
      const changes: PgUpdateSetSource<typeof ledgerPostings> = {
        ...values,
        attempts: sql`${ledgerPostings.attempts} + 1`,
        firstAttemptAt: sql`coalesce(${ledgerPostings.firstAttemptAt}, now())`,
        lastAttemptAt: sql`now()`,
      }

      // Clear the lease on terminal/moved states so a subsequent resolution can be claimed immediately.
      if (outcome !== "retrying") {
        changes.claimedUntil = sql`now()`
      }

      const rows = yield* database.use((db) => {
        const moved = db.$with("moved").as(
          db
            .update(ledgerPostings)
            .set(changes)
            .where(
              and(
                eq(ledgerPostings.id, posting.id),
                eq(ledgerPostings.state, posting.state),
                eq(ledgerPostings.claimId, claim),
              ),
            )
            .returning({ id: ledgerPostings.id, payoutId: ledgerPostings.payoutId }),
        )

        if (payout === undefined || posting.payoutId === null) {
          return db.with(moved).select({ id: moved.id }).from(moved)
        }

        const followed = db.$with("followed").as(
          db
            .update(payouts)
            .set(payout)
            .from(moved)
            .where(and(eq(payouts.id, moved.payoutId), inArray(payouts.status, [...from])))
            .returning({ id: payouts.id }),
        )

        return db.with(moved, followed).select({ id: moved.id }).from(moved)
      })

      if (rows.length === 0) {
        yield* Effect.logDebug("ledger posting resolved elsewhere or its claim lost", outcome).pipe(
          Effect.annotateLogs({ postingId: posting.id, claimId: claim }),
        )
      }

      return outcome
    })

  const retrying = (claim: ClaimID, posting: Posting, reason: string) =>
    Effect.logWarning("ledger posting left to retry", reason).pipe(
      Effect.annotateLogs({ postingId: posting.id }),
      Effect.andThen(commit(claim, posting, "retrying", {})),
    )

  // Marks a permanently rejected posting `refused` so it leaves the relay queue.
  // For payout holds, `idempotency_conflict` flags the payout for `attention`
  // (since an entry may already exist under that key); other rejections mark the
  // payout `rejected` (including payouts previously flagged as `attention` after `holdDeadline`).
  const refused = (claim: ClaimID, posting: Posting, code: string, ...details: ReadonlyArray<object>) =>
    (posting.payoutId !== null && code === "insufficient_funds"
      ? Effect.logInfo("ledger refused payout hold", code)
      : Effect.logError("ledger refused posting", code, ...details)).pipe(
      Effect.annotateLogs({ postingId: posting.id }),
      Effect.andThen(
        commit(
          claim,
          posting,
          "refused",
          { state: "refused", errorCode: code },
          code === "idempotency_conflict" ? { status: "attention" } : { status: "rejected", completedAt: sql`now()` },
          ["requested", "attention"],
        ),
      ),
    )

  const post = (claim: ClaimID, posting: Posting) =>
    Effect.gen(function* () {
      const sent = yield* Effect.result(
        client
          .postJournalEntry({
            params: { "Idempotency-Key": posting.id },
            payload: {
              ledger: posting.ledger,
              kind: posting.kind,
              description: posting.description,
              pending: posting.pending,
              lines: posting.lines.map((line) => ({
                debit_account_ref: line.debit_account_ref,
                credit_account_ref: line.credit_account_ref,
                amount: Number(line.amount),
                purpose: line.purpose,
              })),
            },
          })
          .pipe(Effect.timeout(sendTimeout)),
      )

      if (Result.isFailure(sent)) {
        if (Cause.isTimeoutError(sent.failure)) {
          return yield* retrying(claim, posting, "ledger timed out")
        }

        const verdict = yield* LedgerClient.classify(sent.failure)

        return yield* LedgerClient.Verdict.$match(verdict, {
          Unavailable: () => retrying(claim, posting, "ledger unavailable"),
          BadResponse: ({ reason }) => retrying(claim, posting, reason),
          Rejected: ({ code }) => refused(claim, posting, code),
          Invalid: ({ response }) => refused(claim, posting, response.error.code, response),
        })
      }

      const entry = sent.success
      const recordedAt = DateTime.make(entry.created_at)

      if (entry.ledger_slug !== posting.ledger || Option.isNone(recordedAt)) {
        return yield* retrying(
          claim,
          posting,
          `ledger answered ${entry.ledger_slug} at ${entry.created_at} for ${posting.ledger}`,
        )
      }

      // If the returned entry state does not match `posting.pending`, mark the
      // posting `refused` (`unexpected_state`) and flag any payout for `attention`.
      const expected = posting.pending ? "pending" : "posted"

      if (entry.state !== expected) {
        return yield* Effect.logError("ledger recorded posting in another state", entry.state, expected).pipe(
          Effect.annotateLogs({ postingId: posting.id, journalRef: entry.journal_ref }),
          Effect.andThen(
            commit(claim, posting, "refused", {
              state: "refused",
              errorCode: "unexpected_state",
              journalRef: entry.journal_ref,
              recordedAt: DateTime.toDateUtc(recordedAt.value),
            }, { status: "attention" }),
          ),
        )
      }

      return yield* commit(claim, posting, "posted", {
        state: expected,
        journalRef: entry.journal_ref,
        recordedAt: DateTime.toDateUtc(recordedAt.value),
      }, { status: "held" })
    })

  // Records the ledger's resolution state (`posted` for captured, `voided` for
  // voided), even if it contradicts `asked` (e.g. on `entry_resolved`).
  const settled = (
    claim: ClaimID,
    posting: Posting,
    asked: Resolution,
    pendingState: EntryState,
    resolutionRef: string,
  ) => {
    const state = resolvedStates[pendingState]

    const annotated = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.annotateLogs({ postingId: posting.id, resolutionRef }))

    if (state === undefined) {
      return annotated(Effect.logError("ledger left hold unresolved", pendingState, asked)).pipe(
        Effect.andThen(commit(claim, posting, "refused", { state: "refused", errorCode: "unexpected_state" })),
      )
    }

    const mismatch = (state === "posted") !== (asked === "capture")
      ? annotated(Effect.logError("ledger resolved hold the other way", pendingState, asked))
      : Effect.void

    return Effect.andThen(mismatch, commit(claim, posting, state, { state, resolutionRef }))
  }

  const isResolved = Schema.is(Schema.Struct({
    error: Schema.Struct({ code: Schema.Literal("entry_resolved") }),
    pending_state: EntryState,
    resolved_by: Schema.String,
  }))

  const resolve = (claim: ClaimID, posting: Posting, journalRef: string, resolution: Resolution) =>
    Effect.gen(function* () {
      const sent = yield* Effect.result(
        client
          .resolveJournalEntry(journalRef, {
            params: { "Idempotency-Key": `${posting.id}:${resolution}` },
            payload: { ledger: posting.ledger, action: resolution },
          })
          .pipe(Effect.timeout(sendTimeout)),
      )

      if (Result.isFailure(sent)) {
        if (Cause.isTimeoutError(sent.failure)) {
          return yield* retrying(claim, posting, "ledger timed out")
        }

        if (isResolved(sent.failure)) {
          return yield* settled(claim, posting, resolution, sent.failure.pending_state, sent.failure.resolved_by)
        }

        const verdict = yield* LedgerClient.classify(sent.failure)

        const unresolved = (code: string, ...details: ReadonlyArray<object>) =>
          Effect.logError("ledger refused resolution", code, resolution, ...details).pipe(
            Effect.annotateLogs({ postingId: posting.id, journalRef }),
            Effect.andThen(commit(claim, posting, "refused", { state: "refused", errorCode: code })),
          )

        return yield* LedgerClient.Verdict.$match(verdict, {
          Unavailable: () => retrying(claim, posting, "ledger unavailable"),
          BadResponse: ({ reason }) => retrying(claim, posting, reason),
          Rejected: ({ code }) => unresolved(code),
          Invalid: ({ response }) => unresolved(response.error.code, response),
        })
      }

      const entry = sent.success

      if (entry.ledger_slug !== posting.ledger || entry.pending_ref !== journalRef) {
        return yield* Effect.logError(
          "ledger resolved another hold",
          `${entry.pending_ref} in ${entry.ledger_slug}`,
          resolution,
        ).pipe(
          Effect.annotateLogs({ postingId: posting.id, journalRef }),
          Effect.andThen(commit(claim, posting, "refused", { state: "refused", errorCode: "unexpected_entry" })),
        )
      }

      return yield* settled(claim, posting, resolution, entry.pending_state, entry.journal_ref)
    })

  const send = Effect.fn("LedgerPostings.send")(function* (claim: ClaimID, posting: Posting) {
    if (posting.state === "created") {
      return yield* post(claim, posting)
    }

    if (posting.state !== "pending" || posting.journalRef === null || posting.resolution === null) {
      yield* Effect.logError("ledger posting has nothing the relay can send", posting.state).pipe(
        Effect.annotateLogs({ postingId: posting.id }),
      )

      return "skipped" as const
    }

    return yield* resolve(claim, posting, posting.journalRef, posting.resolution)
  })

  // Releases the lease on any rows from `claim` still in `created` or `pending`.
  const release = (claim: ClaimID) =>
    database
      .use((db) =>
        db
          .update(ledgerPostings)
          .set({ claimedUntil: sql`now()` })
          .where(and(eq(ledgerPostings.claimId, claim), inArray(ledgerPostings.state, ["created", "pending"]))),
      )
      .pipe(Effect.catchCause((cause) => Effect.logError("could not release ledger postings", cause)))

  // Claims and sends outside a database transaction so no connection is held
  // across ledger HTTP calls. `acquireUseRelease` guarantees `claim` is
  // uninterruptible and `release` runs if the pass fails or is interrupted.
  const relay = Effect.acquireUseRelease(
    claim(relayBatchSize),
    ({ id, postings }) =>
      Effect.gen(function* () {
        for (const posting of postings) {
          if ((yield* send(id, posting)) === "retrying") {
            return yield* new UnavailableError()
          }
        }
      }),
    ({ id }, exit) => (Exit.isFailure(exit) ? release(id) : Effect.void),
  ).pipe(Effect.withSpan("LedgerPostings.relay"))

  return Service.of({ claim, send, relay })
})

export const layer = Layer.effect(Service)(make)

export * as LedgerPostings from "./postings.ts"
