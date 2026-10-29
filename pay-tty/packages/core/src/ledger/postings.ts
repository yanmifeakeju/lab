import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm"
import { Array as Arr, Cause, Context, DateTime, Duration, Effect, Exit, Layer, Option, Order, Result, Schema } from "effect"

import { Database } from "../database/client.ts"
import { createId } from "../database/ids.ts"
import { LedgerClient } from "./client.ts"
import { Ledger } from "./slug.ts"
import { ledgerPostings, postingStates } from "./sql.ts"

/** How many postings one relay pass claims. */
export const relayBatchSize = 10

/** The longest one send waits on the ledger; past it, the ledger counts as down. */
export const sendTimeout = Duration.seconds(5)

/**
 * How long a claim keeps a batch from other passes. Twice a batch of sends
 * that all time out, so the records fit too and a lease never expires under
 * the pass still working through it.
 */
export const claimLease = Duration.times(sendTimeout, relayBatchSize * 2)

export const ID = Schema.String.pipe(
  Schema.check(Schema.isStartsWith("lpost_")),
  Schema.brand("LedgerPostings.ID"),
)

export type ID = typeof ID.Type

export const State = Schema.Literals(postingStates)

export type State = typeof State.Type

/** A line as the ledger takes it, with the amount as decimal text. */
export class Line extends Schema.Class<Line>("LedgerPostings.Line")({
  debit_account_ref: Schema.String,
  credit_account_ref: Schema.String,
  amount: Schema.String,
  purpose: Schema.String,
}) {}

/** A posting waiting to be sent, with the entry it asks the ledger for. */
export class Posting extends Schema.Class<Posting>("LedgerPostings.Posting")({
  id: ID,
  ledger: Ledger.Slug,
  kind: Schema.String,
  description: Schema.String,
  effectiveAt: Schema.Date,
  lines: Schema.Array(Line),
}) {}

export const ClaimID = Schema.String.pipe(
  Schema.check(Schema.isStartsWith("lclaim_")),
  Schema.brand("LedgerPostings.ClaimID"),
)

export type ClaimID = typeof ClaimID.Type

/** A batch leased to one relay pass, oldest first. */
export class Claim extends Schema.Class<Claim>("LedgerPostings.Claim")({
  id: ClaimID,
  postings: Schema.Array(Posting),
}) {}

/** What became of a posting once sent. */
export type Outcome = "posted" | "refused" | "retrying"

/** The ledger couldn't take postings: it is down, or answered with nonsense. */
export class UnavailableError extends Schema.TaggedError<UnavailableError>()(
  "LedgerPostings.UnavailableError",
  {},
) {}

export interface Interface {
  /**
   * Leases the oldest postings still to be sent, skipping those under another
   * pass's lease, and commits at once. A pass that dies holding a lease
   * leaves its postings to the next claim after the lease expires.
   */
  readonly claim: (limit: number) => Effect.Effect<Claim>
  /**
   * Sends the posting, keyed by its ID, and commits the ledger's answer if
   * the claim still holds it. A posting left to retry counts the attempt. One
   * the ledger will never take, even a bug of ours such as a changed entry, is
   * refused and logged. Sending twice is safe: the ledger replays the entry.
   */
  readonly send: (claim: ClaimID, posting: Posting) => Effect.Effect<Outcome>
  /**
   * Claims a batch and sends it one posting at a time, stopping at the first
   * the ledger couldn't take. A pass that stops early, fails or is
   * interrupted releases what it left unsent to the next pass.
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

  // Leases use the database's clock, so plane instances can't disagree. A
  // lease that ends at now() is free: releasing sets it so.
  const claim = Effect.fn("LedgerPostings.claim")(function* (limit: number) {
    const id = ClaimID.make(createId("lclaim"))

    const rows = yield* database.use((db) =>
      db
        .update(ledgerPostings)
        .set({
          claimId: id,
          claimedUntil: sql`now() + make_interval(secs => ${Duration.toSeconds(claimLease)})`,
        })
        .where(
          inArray(
            ledgerPostings.id,
            db
              .select({ id: ledgerPostings.id })
              .from(ledgerPostings)
              .where(
                and(
                  eq(ledgerPostings.state, "created"),
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
      // RETURNING doesn't keep the subquery's order.
      postings: Arr.sort(rows, oldestFirst).map(
        (row) =>
          new Posting({
            id: ID.make(row.id),
            ledger: Ledger.Slug.make(row.ledger),
            kind: row.kind,
            description: row.description,
            effectiveAt: row.effectiveAt,
            lines: row.lines.map((line) => new Line(line)),
          }),
      ),
    })
  })

  // Every transition starts from created, so a posting is resolved once, and
  // only by the pass that holds it.
  const resolve = (
    claim: ClaimID,
    posting: Posting,
    outcome: Outcome,
    values: Partial<typeof ledgerPostings.$inferInsert>,
  ) =>
    Effect.gen(function* () {
      const rows = yield* database.use((db) =>
        db
          .update(ledgerPostings)
          .set({ ...values, attempts: sql`${ledgerPostings.attempts} + 1`, lastAttemptAt: sql`now()` })
          .where(
            and(
              eq(ledgerPostings.id, posting.id),
              eq(ledgerPostings.state, "created"),
              eq(ledgerPostings.claimId, claim),
            ),
          )
          .returning({ id: ledgerPostings.id }),
      )

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
      Effect.andThen(resolve(claim, posting, "retrying", {})),
    )

  // Out of the queue for good: retrying sends the same entry and gets the same
  // answer, and would hold up every posting behind it.
  const refused = (claim: ClaimID, posting: Posting, code: string, ...details: ReadonlyArray<object>) =>
    Effect.logError("ledger refused posting", code, ...details).pipe(
      Effect.annotateLogs({ postingId: posting.id }),
      Effect.andThen(resolve(claim, posting, "refused", { state: "refused", errorCode: code })),
    )

  const send = Effect.fn("LedgerPostings.send")(function* (claim: ClaimID, posting: Posting) {
    const sent = yield* Effect.result(
      client
        .postJournalEntry({
          params: { "Idempotency-Key": posting.id },
          payload: {
            ledger: posting.ledger,
            kind: posting.kind,
            description: posting.description,
            effective_at: posting.effectiveAt.toISOString(),
            // Exact: stored amounts never pass the safe integers.
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
      // The ledger may have posted anyway; the next send gets its replay.
      if (Cause.isTimeoutError(sent.failure)) {
        return yield* retrying(claim, posting, "ledger timed out")
      }

      const verdict = yield* LedgerClient.classify(sent.failure)

      return yield* LedgerClient.Verdict.$match(verdict, {
        Unavailable: () => retrying(claim, posting, "ledger unavailable"),
        BadResponse: ({ reason }) => retrying(claim, posting, reason),
        // idempotency_conflict and a 400 are bugs of ours: the stored entry
        // changed after it was first sent, or was built wrong.
        Rejected: ({ code }) => refused(claim, posting, code),
        Invalid: ({ response }) => refused(claim, posting, response.error.code, response),
      })
    }

    // A replay answers with the entry first posted, as a first post does.
    const entry = sent.success
    const recordedAt = DateTime.make(entry.created_at)

    if (entry.ledger_slug !== posting.ledger || Option.isNone(recordedAt)) {
      return yield* retrying(
        claim,
        posting,
        `ledger answered ${entry.ledger_slug} at ${entry.created_at} for ${posting.ledger}`,
      )
    }

    return yield* resolve(claim, posting, "posted", {
      state: "posted",
      journalRef: entry.journal_ref,
      recordedAt: DateTime.toDateUtc(recordedAt.value),
    })
  })

  // Ends the lease on what the claim left unresolved, so it goes first in the
  // next pass rather than waiting out the lease. Best-effort: expiry frees it
  // anyway.
  const release = (claim: ClaimID) =>
    database
      .use((db) =>
        db
          .update(ledgerPostings)
          .set({ claimedUntil: sql`now()` })
          .where(and(eq(ledgerPostings.claimId, claim), eq(ledgerPostings.state, "created"))),
      )
      .pipe(Effect.catchCause((cause) => Effect.logError("could not release ledger postings", cause)))

  // No transaction: each statement commits on its own, so no connection is
  // held while the ledger answers. The claim can't be interrupted: an
  // abandoned claim query still commits, leaving a lease nobody releases.
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
    // A pass that sent everything has nothing left to release.
    ({ id }, exit) => (Exit.isFailure(exit) ? release(id) : Effect.void),
  ).pipe(Effect.withSpan("LedgerPostings.relay"))

  return Service.of({ claim, send, relay })
})

export const layer = Layer.effect(Service)(make)

export * as LedgerPostings from "./postings.ts"
