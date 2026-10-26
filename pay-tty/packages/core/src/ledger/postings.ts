import { and, asc, eq, sql } from "drizzle-orm"
import { Context, DateTime, Effect, Layer, Option, Result, Schema } from "effect"

import { Database } from "../database/client.ts"
import { LedgerClient } from "./client.ts"
import { Ledger } from "./slug.ts"
import { ledgerPostings, postingStates } from "./sql.ts"

/** How many postings one relay pass sends. */
export const relayBatchSize = 50

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

/** What became of a posting once sent. */
export type Outcome = "posted" | "refused" | "retrying"

/** The ledger couldn't take postings: it is down, or answered with nonsense. */
export class UnavailableError extends Schema.TaggedError<UnavailableError>()(
  "LedgerPostings.UnavailableError",
  {},
) {}

export interface Interface {
  /**
   * The oldest postings still to be sent, locked until the transaction ends.
   * Rows another transaction holds are skipped, so two relays never send the
   * same one.
   */
  readonly claim: (limit: number) => Effect.Effect<ReadonlyArray<Posting>>
  /**
   * Sends the posting, keyed by its ID, and records the ledger's answer. A
   * posting left to retry counts the attempt. One the ledger will never take,
   * even a bug of ours such as a changed entry, is refused and logged.
   */
  readonly send: (posting: Posting) => Effect.Effect<Outcome>
  /**
   * Claims a batch and sends it one posting at a time, stopping at the first
   * the ledger couldn't take. What was recorded commits either way.
   */
  readonly relay: Effect.Effect<void, UnavailableError>
}

export class Service extends Context.Service<Service, Interface>()("LedgerPostings") {}

const make = Effect.gen(function* () {
  const database = yield* Database
  const client = yield* LedgerClient.Service

  const claim = Effect.fn("LedgerPostings.claim")(function* (limit: number) {
    const rows = yield* database.use((db) =>
      db
        .select()
        .from(ledgerPostings)
        .where(eq(ledgerPostings.state, "created"))
        .orderBy(asc(ledgerPostings.createdAt), asc(ledgerPostings.id))
        .limit(limit)
        .for("update", { skipLocked: true }),
    )

    return rows.map(
      (row) =>
        new Posting({
          id: ID.make(row.id),
          ledger: Ledger.Slug.make(row.ledger),
          kind: row.kind,
          description: row.description,
          effectiveAt: row.effectiveAt,
          lines: row.lines.map((line) => new Line(line)),
        }),
    )
  })

  // Every transition starts from created, so a posting is resolved once.
  const resolve = (id: ID, values: Partial<typeof ledgerPostings.$inferInsert>) =>
    database.use((db) =>
      db
        .update(ledgerPostings)
        .set({ ...values, attempts: sql`${ledgerPostings.attempts} + 1`, lastAttemptAt: sql`now()` })
        .where(and(eq(ledgerPostings.id, id), eq(ledgerPostings.state, "created"))),
    )

  const retrying = (posting: Posting, reason: string) =>
    Effect.logWarning("ledger posting left to retry", reason).pipe(
      Effect.annotateLogs({ postingId: posting.id }),
      Effect.andThen(resolve(posting.id, {})),
      Effect.as<Outcome>("retrying"),
    )

  // Out of the queue for good: retrying sends the same entry and gets the same
  // answer, and would hold up every posting behind it.
  const refused = (posting: Posting, code: string, ...details: ReadonlyArray<object>) =>
    Effect.logError("ledger refused posting", code, ...details).pipe(
      Effect.annotateLogs({ postingId: posting.id }),
      Effect.andThen(resolve(posting.id, { state: "refused", errorCode: code })),
      Effect.as<Outcome>("refused"),
    )

  const send = Effect.fn("LedgerPostings.send")(function* (posting: Posting) {
    const sent = yield* Effect.result(
      client.postJournalEntry({
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
      }),
    )

    if (Result.isFailure(sent)) {
      const verdict = yield* LedgerClient.classify(sent.failure)

      return yield* LedgerClient.Verdict.$match(verdict, {
        Unavailable: () => retrying(posting, "ledger unavailable"),
        BadResponse: ({ reason }) => retrying(posting, reason),
        // idempotency_conflict and a 400 are bugs of ours: the stored entry
        // changed after it was first sent, or was built wrong.
        Rejected: ({ code }) => refused(posting, code),
        Invalid: ({ response }) => refused(posting, response.error.code, response),
      })
    }

    // A replay answers with the entry first posted, as a first post does.
    const entry = sent.success
    const recordedAt = DateTime.make(entry.created_at)

    if (entry.ledger_slug !== posting.ledger || Option.isNone(recordedAt)) {
      return yield* retrying(posting, `ledger answered ${entry.ledger_slug} at ${entry.created_at} for ${posting.ledger}`)
    }

    yield* resolve(posting.id, {
      state: "posted",
      journalRef: entry.journal_ref,
      recordedAt: DateTime.toDateUtc(recordedAt.value),
    })

    return "posted" as const
  })

  const relay = Effect.gen(function* () {
    const stalled = yield* database.transaction(
      Effect.gen(function* () {
        for (const posting of yield* claim(relayBatchSize)) {
          if ((yield* send(posting)) === "retrying") {
            return true
          }
        }

        return false
      }),
    )

    if (stalled) {
      return yield* new UnavailableError()
    }
  }).pipe(Effect.withSpan("LedgerPostings.relay"))

  return Service.of({ claim, send, relay })
})

export const layer = Layer.effect(Service)(make)

export * as LedgerPostings from "./postings.ts"
