import assert from "node:assert/strict"
import { test } from "node:test"

import { PostJournalEntryRequestJson } from "@pay-tty/ledger-client"
import { and, eq, inArray, sql } from "drizzle-orm"
import { Cause, ConfigProvider, DateTime, Deferred, Duration, Effect, Exit, Fiber, Layer, Predicate, Schema } from "effect"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientError from "effect/unstable/http/HttpClientError"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { ulid } from "ulid"

import { Business } from "../src/business/business.ts"
import { Database, layer as DatabaseLayer } from "../src/database/client.ts"
import { LedgerClient } from "../src/ledger/client.ts"
import { LedgerPostings } from "../src/ledger/postings.ts"
import { Ledger } from "../src/ledger/slug.ts"
import { ledgerPostings, platformAccounts } from "../src/ledger/sql.ts"
import { Payments } from "../src/payments/payments.ts"
import { payments as paymentRows } from "../src/payments/sql.ts"
import { Principal } from "../src/principal/principal.ts"
import { Testing } from "../src/testing/testing.ts"
import { runtime } from "./runtime.ts"

const createBusiness = () =>
  Effect.gen(function* () {
    const principals = yield* Principal.Service
    const businesses = yield* Business.Service

    const principal = yield* principals.ensure({ issuer: "postings-test", subject: ulid() })
    const business = yield* businesses.create(principal.id, new Business.Details({ name: "Adaeze Studio", countryCode: "NG" }))
    const accountRef = yield* Testing.openAccount(business.id)

    return { business, accountRef }
  })

const key = () => Payments.IdempotencyKey.make(`key_${ulid()}`)

const fixed = new Payments.Details({
  title: "Logo design",
  description: null,
  pricing: new Payments.Fixed({ amount: 2_500_000n }),
})

const linkOf = (businessId: Business.ID) =>
  Effect.gen(function* () {
    const service = yield* Payments.Service

    return (yield* service.createLink(businessId, key(), fixed)).link
  })

const paid = (link: Payments.Link, outcome: Payments.Outcome = "succeeded") =>
  Effect.gen(function* () {
    const service = yield* Payments.Service
    const { payment } = yield* service.startPayment(link.shareToken, key(), null)

    return yield* service.simulate(link.shareToken, payment.id, outcome)
  })

const postingsOf = (paymentIds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const database = yield* Database

    return yield* database.use((db) =>
      db.select().from(ledgerPostings).where(inArray(ledgerPostings.paymentId, [...paymentIds])),
    )
  })

const postingOf = (paymentId: string) =>
  Effect.gen(function* () {
    const [posting, ...rest] = yield* postingsOf([paymentId])

    assert.equal(rest.length, 0)
    assert.ok(posting !== undefined, `payment ${paymentId} has a posting`)

    return posting
  })

const asPosting = (row: typeof ledgerPostings.$inferSelect) =>
  new LedgerPostings.Posting({
    id: LedgerPostings.ID.make(row.id),
    ledger: Ledger.Slug.make(row.ledger),
    kind: row.kind,
    description: row.description,
    effectiveAt: row.effectiveAt,
    lines: row.lines.map((line) => new LedgerPostings.Line(line)),
  })

// The constraint a failed query violated; pg's error is the cause Drizzle wraps.
const violated = <A, E>(exit: Exit.Exit<A, E>) => {
  if (Exit.isSuccess(exit)) {
    return undefined
  }

  const defect = Cause.squash(exit.cause)
  const error = defect instanceof Error && defect.cause instanceof Error ? defect.cause : undefined

  return error !== undefined && "constraint" in error ? error.constraint : undefined
}

type Payload = PostJournalEntryRequestJson

interface Sent {
  readonly key: string | null
  readonly payload: Payload
}

interface Answer {
  readonly status: number
  readonly body: object
}

type Reply = Answer | "unreachable"

const isAnswer = (reply: Reply | Effect.Effect<Reply>): reply is Reply => !Effect.isEffect(reply)

// The ledger's answer to a posting: the same entry for a replay of a key.
const entry = (payload: Payload, journalRef: string, createdAt = "2026-10-26T14:02:00Z"): Answer => ({
  status: 201,
  body: {
    journal_ref: journalRef,
    ledger_slug: payload.ledger,
    kind: payload.kind,
    state: "posted",
    description: payload.description,
    effective_at: payload.effective_at ?? createdAt,
    created_at: createdAt,
  },
})

const refusal = (status: number, code: string): Reply => ({
  status,
  body: { message: "The ledger could not complete the request.", error: { code } },
})

// The ledger service, faked at the HTTP boundary so the client and its
// decoding still run.
const fakeLedger = (reply: (sent: Sent) => Reply | Effect.Effect<Reply>) => {
  const sent: Array<Sent> = []

  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      const web = yield* Effect.orDie(HttpClientRequest.toWeb(request))

      const payload = yield* Effect.orDie(
        Schema.decodeUnknownEffect(PostJournalEntryRequestJson)(yield* Effect.promise(() => web.json())),
      )

      const call = { key: web.headers.get("idempotency-key"), payload }

      sent.push(call)

      const replied = reply(call)
      const answer = isAnswer(replied) ? replied : yield* replied

      if (answer === "unreachable") {
        return yield* new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, description: "connection refused" }),
        })
      }

      return HttpClientResponse.fromWeb(request, Response.json(answer.body, { status: answer.status }))
    }),
  )

  const layer = LedgerPostings.layer.pipe(
    Layer.provide(LedgerClient.layer),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ LEDGER_BASE_URL: "http://ledger.test" }))),
    Layer.orDie,
  )

  return { sent, layer }
}

// Leases the row to a pass of the test's own, as a claim does.
const leased = (id: string) =>
  Effect.gen(function* () {
    const database = yield* Database
    const claim = LedgerPostings.ClaimID.make(`lclaim_${ulid()}`)

    yield* database.use((db) =>
      db
        .update(ledgerPostings)
        .set({ claimId: claim, claimedUntil: sql`now() + interval '1 minute'` })
        .where(eq(ledgerPostings.id, id)),
    )

    return claim
  })

const send = (row: typeof ledgerPostings.$inferSelect, claim?: LedgerPostings.ClaimID) =>
  Effect.gen(function* () {
    const postings = yield* LedgerPostings.Service

    return yield* postings.send(claim ?? (yield* leased(row.id)), asPosting(row))
  })

// Whether each row's lease has ended, by the database's clock, and who held it.
const leasesOf = (ids: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const database = yield* Database

    const rows = yield* database.use((db) =>
      db
        .select({
          id: ledgerPostings.id,
          claimId: ledgerPostings.claimId,
          ended: sql<boolean>`${ledgerPostings.claimedUntil} <= now()`,
        })
        .from(ledgerPostings)
        .where(inArray(ledgerPostings.id, [...ids])),
    )

    return new Map(rows.map((row) => [row.id, row]))
  })

// The database, with every statement after the first `ok` failing as a lost
// connection would.
const failingAfter = (ok: number) =>
  Layer.effect(Database)(
    Effect.gen(function* () {
      const database = yield* Database
      let statements = 0

      return Database.of({
        use: (query) => (statements++ < ok ? database.use(query) : Effect.die(new Error("connection lost"))),
        transaction: database.transaction,
      })
    }),
  )

// The database, with the first statement held until `go` and then run to the
// end whatever its caller does, as a query already sent would be.
const heldFirst = (sent: Deferred.Deferred<void>, go: Deferred.Deferred<void>, done: Deferred.Deferred<void>) =>
  Layer.effect(Database)(
    Effect.gen(function* () {
      const database = yield* Database
      let statements = 0

      return Database.of({
        use: (query) =>
          statements++ > 0
            ? database.use(query)
            : Effect.gen(function* () {
                const context = yield* Effect.context<never>()

                const run = Deferred.succeed(sent, undefined).pipe(
                  Effect.andThen(Deferred.await(go)),
                  Effect.andThen(database.use(query)),
                  Effect.ensuring(Deferred.succeed(done, undefined)),
                )

                return yield* Effect.promise(() => Effect.runPromiseWith(context)(run))
              }),
        transaction: database.transaction,
      })
    }),
  )

void test("a succeeded payment commits with one posting of its amount from cash to the business's account", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const { business, accountRef } = yield* createBusiness()
        const link = yield* linkOf(business.id)
        const payment = yield* paid(link)

        const posting = yield* postingOf(payment.id)

        assert.match(posting.id, /^lpost_[0-9A-HJKMNP-TV-Z]{26}$/)
        assert.equal(posting.businessId, business.id)
        assert.equal(posting.ledger, link.ledger)
        assert.equal(posting.kind, "payment")
        assert.equal(posting.description, `Payment received via ${link.title}`)
        assert.deepEqual(posting.effectiveAt, payment.completedAt)
        assert.deepEqual(posting.lines, [
          { debit_account_ref: "acct_test_cash", credit_account_ref: accountRef, amount: "2500000", purpose: "payment" },
        ])
        assert.equal(posting.state, "created")
        assert.equal(posting.attempts, 0)
        assert.equal(posting.journalRef, null)
        assert.equal(posting.recordedAt, null)

        const others = yield* Effect.all([paid(link, "failed"), paid(link, "cancelled")])

        assert.deepEqual(yield* postingsOf(others.map((other) => other.id)), [])
      }),
    ),
  ))

void test("a success that can't be posted is not a success: the payment stays pending", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const database = yield* Database
        const service = yield* Payments.Service
        const { business } = yield* createBusiness()
        const link = yield* linkOf(business.id)
        const { payment } = yield* service.startPayment(link.shareToken, key(), null)

        // A seeding error: the ledger has no cash account to post from.
        yield* database.use((db) =>
          db
            .delete(platformAccounts)
            .where(and(eq(platformAccounts.ledger, link.ledger), eq(platformAccounts.label, "cash"))),
        )

        const exit = yield* Testing.attempt(service.simulate(link.shareToken, payment.id, "succeeded"))

        assert.ok(Exit.hasDies(exit))

        const rows = yield* database.use((db) => db.select().from(paymentRows).where(eq(paymentRows.id, payment.id)))

        assert.equal(rows[0]?.status, "pending")
        assert.deepEqual(yield* postingsOf([payment.id]), [])
      }),
    ),
  ))

void test("the database keeps a posting in its payment's ledger, one per payment, and its state consistent", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const database = yield* Database
        const { business } = yield* createBusiness()
        const link = yield* linkOf(business.id)
        const payment = yield* paid(link)
        const existing = yield* postingOf(payment.id)
        const unposted = yield* paid(link, "failed")

        const other = Ledger.Slug.make(`ngn_other_${ulid().toLowerCase()}`)

        yield* Testing.addLedger(other, "NGN", 2)

        const insert = (row: Partial<typeof ledgerPostings.$inferInsert>) =>
          Testing.attempt(
            database.use((db) =>
              db.insert(ledgerPostings).values({
                id: `lpost_${ulid()}`,
                businessId: existing.businessId,
                ledger: existing.ledger,
                paymentId: existing.paymentId,
                kind: existing.kind,
                description: existing.description,
                effectiveAt: existing.effectiveAt,
                lines: existing.lines,
                ...row,
              }),
            ),
          )

        // Stands in for refunds and payouts, which aren't causes yet.
        const unpaid = { paymentId: null }

        assert.equal(violated(yield* insert({ paymentId: unposted.id, ledger: other })), "ledger_postings_payment_ledger_fk")
        assert.ok(Exit.isSuccess(yield* insert({ paymentId: unposted.id })))
        assert.equal(violated(yield* insert({})), "ledger_postings_payment_unique")
        assert.equal(violated(yield* insert(unpaid)), "ledger_postings_one_cause")

        const update = (values: Partial<typeof ledgerPostings.$inferInsert>) =>
          Testing.attempt(
            database.use((db) => db.update(ledgerPostings).set(values).where(eq(ledgerPostings.id, existing.id))),
          )

        const at = DateTime.toDate(yield* DateTime.now)

        const rejected: ReadonlyArray<readonly [string, Partial<typeof ledgerPostings.$inferInsert>]> = [
          ["created with a journal entry", { journalRef: "jrn_1", recordedAt: at }],
          ["created with an error", { errorCode: "account_closed" }],
          ["pending without its authorization", { state: "pending" }],
          ["pending already resolved", { state: "pending", journalRef: "jrn_1", recordedAt: at, resolutionRef: "jrn_2" }],
          ["posted without a journal entry", { state: "posted" }],
          ["posted with an error", { state: "posted", journalRef: "jrn_1", recordedAt: at, errorCode: "account_closed" }],
          ["voided without its resolution", { state: "voided", journalRef: "jrn_1", recordedAt: at }],
          ["expired without its resolution", { state: "expired", journalRef: "jrn_1", recordedAt: at }],
          ["refused without an error", { state: "refused" }],
          ["refused with a resolution", { state: "refused", errorCode: "account_closed", journalRef: "jrn_1", recordedAt: at, resolutionRef: "jrn_2" }],
        ]

        for (const [reason, values] of rejected) {
          assert.equal(violated(yield* update(values)), "ledger_postings_state_shape", reason)
        }

        assert.equal(violated(yield* update({ state: "posted", journalRef: "jrn_1" })), "ledger_postings_recorded_with_journal")
        assert.equal(violated(yield* update({ state: "refused", errorCode: "account_closed", recordedAt: at })), "ledger_postings_recorded_with_journal")

        for (const values of [
          { state: "posted", journalRef: "jrn_1", recordedAt: at },
          { state: "pending", journalRef: "jrn_1", recordedAt: at },
          { state: "voided", journalRef: "jrn_1", recordedAt: at, resolutionRef: "jrn_2" },
          { state: "refused", errorCode: "account_closed" },
        ] as const) {
          assert.ok(Exit.isSuccess(yield* update(values)), values.state)
        }

        // A payment with a posting can't be deleted.
        const removal = yield* Testing.attempt(
          database.use((db) => db.delete(paymentRows).where(eq(paymentRows.id, payment.id))),
        )

        assert.equal(violated(removal), "ledger_postings_payment_id_payments_id_fk")
      }),
    ),
  ))

void test("the posting goes to the ledger under its own key with the stored entry, and a replay posts it the same", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const database = yield* Database
        const { business, accountRef } = yield* createBusiness()
        const payment = yield* paid(yield* linkOf(business.id))
        const row = yield* postingOf(payment.id)

        // A replay answers 200 with the entry first posted.
        const ledger = fakeLedger(({ payload }) => ({ ...entry(payload, "jrn_first"), status: ledger.sent.length > 1 ? 200 : 201 }))

        const outcome = yield* send(row).pipe(Effect.provide(ledger.layer))

        assert.equal(outcome, "posted")
        assert.deepEqual(ledger.sent, [{
          key: row.id,
          payload: {
            ledger: row.ledger,
            kind: "payment",
            description: row.description,
            effective_at: payment.completedAt?.toISOString(),
            lines: [{ debit_account_ref: "acct_test_cash", credit_account_ref: accountRef, amount: 2_500_000, purpose: "payment" }],
          },
        }])

        const posted = yield* postingOf(payment.id)

        assert.equal(posted.state, "posted")
        assert.equal(posted.journalRef, "jrn_first")
        assert.deepEqual(posted.recordedAt, DateTime.toDate(DateTime.makeUnsafe("2026-10-26T14:02:00Z")))
        assert.equal(posted.attempts, 1)

        // As though the first answer was lost: the replay is sent byte for byte
        // and records the same entry.
        yield* database.use((db) =>
          db
            .update(ledgerPostings)
            .set({ state: "created", journalRef: null, recordedAt: null })
            .where(eq(ledgerPostings.id, row.id)),
        )

        assert.equal(yield* send(row).pipe(Effect.provide(ledger.layer)), "posted")
        assert.deepEqual(ledger.sent[1], ledger.sent[0])
        assert.equal((yield* postingOf(payment.id)).journalRef, "jrn_first")
      }),
    ),
  ))

void test("a refusal is recorded with its code, and a failure leaves the posting to retry", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const { business } = yield* createBusiness()
        const link = yield* linkOf(business.id)
        const refused = yield* postingOf((yield* paid(link)).id)
        const retried = yield* postingOf((yield* paid(link)).id)

        const closed = fakeLedger(() => refusal(409, "account_closed"))

        assert.equal(yield* send(refused).pipe(Effect.provide(closed.layer)), "refused")

        const stored = yield* postingOf(refused.paymentId ?? "")

        assert.deepEqual([stored.state, stored.errorCode, stored.journalRef, stored.attempts], ["refused", "account_closed", null, 1])
        assert.ok(stored.lastAttemptAt !== null)

        // Down, then a 500, then it posts.
        const replies: Array<Reply> = ["unreachable", refusal(500, "internal_server_error")]
        const flaky = fakeLedger(({ payload }) => replies.shift() ?? entry(payload, "jrn_retried"))

        for (const expected of ["retrying", "retrying", "posted"] as const) {
          assert.equal(yield* send(retried).pipe(Effect.provide(flaky.layer)), expected)
        }

        const posted = yield* postingOf(retried.paymentId ?? "")

        assert.deepEqual([posted.state, posted.journalRef, posted.attempts], ["posted", "jrn_retried", 3])
        assert.equal(new Set(flaky.sent.map((call) => JSON.stringify(call))).size, 1, "every retry is identical")
      }),
    ),
  ))

void test("a ledger that answers for another ledger, or with nonsense, leaves the posting to retry", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const { business } = yield* createBusiness()
        const row = yield* postingOf((yield* paid(yield* linkOf(business.id))).id)

        const elsewhere = fakeLedger(({ payload }) => entry({ ...payload, ledger: "usd_us" }, "jrn_elsewhere"))
        const garbled = fakeLedger(() => ({ status: 201, body: { journal_ref: "jrn_garbled" } }))

        assert.equal(yield* send(row).pipe(Effect.provide(elsewhere.layer)), "retrying")
        assert.equal(yield* send(row).pipe(Effect.provide(garbled.layer)), "retrying")

        const stored = yield* postingOf(row.paymentId ?? "")

        assert.deepEqual([stored.state, stored.journalRef, stored.attempts], ["created", null, 2])
      }),
    ),
  ))

const relay = (layer: Layer.Layer<LedgerPostings.Service, never, Database>) =>
  Effect.gen(function* () {
    const postings = yield* LedgerPostings.Service

    return yield* postings.relay
  }).pipe(Effect.provide(layer))

// Other test files may have committed postings of their own, which a pass
// claims too, so only this test's postings are checked.
void test("a relay pass sends what is waiting and stops at the first posting the ledger can't take", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const { business } = yield* createBusiness()
        const link = yield* linkOf(business.id)
        const ids = [(yield* paid(link)).id, (yield* paid(link)).id, (yield* paid(link)).id]
        const [first, second, third] = yield* Effect.forEach(ids, postingOf)

        // The ledger takes the first and is down at the second.
        const down = fakeLedger(({ payload, key }) => (key === second?.id ? "unreachable" : entry(payload, `jrn_${key}`)))

        assert.ok(Predicate.isTagged(yield* Effect.flip(relay(down.layer)), "LedgerPostings.UnavailableError"))

        const after = new Map((yield* postingsOf(ids)).map((row) => [row.id, [row.state, row.attempts]]))

        assert.deepEqual(after.get(first?.id ?? ""), ["posted", 1])
        assert.deepEqual(after.get(second?.id ?? ""), ["created", 1])
        assert.deepEqual(after.get(third?.id ?? ""), ["created", 0], "not sent once the ledger was down")

        // The retried posting and the unsent one are released, still naming
        // the pass that held them.
        const leases = yield* leasesOf([first, second, third].map((row) => row?.id ?? ""))
        const claim = leases.get(first?.id ?? "")?.claimId

        assert.ok(claim !== null && claim !== undefined)

        for (const id of [second?.id, third?.id]) {
          assert.deepEqual([leases.get(id ?? "")?.claimId, leases.get(id ?? "")?.ended], [claim, true])
        }

        // Back up: the rest go through in order, and a pass with nothing to
        // send is quiet.
        const up = fakeLedger(({ payload, key }) => entry(payload, `jrn_${key}`))

        yield* relay(up.layer)
        assert.deepEqual((yield* postingsOf(ids)).map((row) => row.state), ["posted", "posted", "posted"])
        assert.deepEqual(
          up.sent.map((call) => call.key).filter((key) => key === second?.id || key === third?.id),
          [second?.id, third?.id],
        )

        // Only ours: other files may commit postings while this runs.
        const ours = new Set([first?.id, second?.id, third?.id])
        const sent = () => up.sent.filter((call) => ours.has(call.key ?? "")).length
        const before = sent()

        yield* relay(up.layer)
        assert.equal(sent(), before)
      }),
    ),
  ))

void test("a posting the ledger will never take leaves the queue, and the rest of the pass still commits", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const { business } = yield* createBusiness()
        const link = yield* linkOf(business.id)
        const ids = [(yield* paid(link)).id, (yield* paid(link)).id, (yield* paid(link)).id]
        const [conflicted, invalid, fine] = yield* Effect.forEach(ids, postingOf)

        // The first saw another entry under its key, and the second was built
        // wrong; neither will ever change on a retry.
        const ledger = fakeLedger(({ payload, key }) => {
          if (key === conflicted?.id) {
            return refusal(409, "idempotency_conflict")
          }

          return key === invalid?.id
            ? {
                status: 400,
                body: {
                  message: "Request validation failed.",
                  error: {
                    code: "validation_error",
                    details: [{ location: "body", field: "lines", code: "invalid_value", message: "lines are invalid" }],
                  },
                },
              }
            : entry(payload, `jrn_${key}`)
        })

        yield* relay(ledger.layer)

        const after = new Map((yield* postingsOf(ids)).map((row) => [row.id, [row.state, row.errorCode]]))

        assert.deepEqual(after.get(conflicted?.id ?? ""), ["refused", "idempotency_conflict"])
        assert.deepEqual(after.get(invalid?.id ?? ""), ["refused", "validation_error"])
        assert.deepEqual(after.get(fine?.id ?? ""), ["posted", null])

        // Out of the queue: the next pass sends neither again.
        const refusedKeys = new Set([conflicted?.id, invalid?.id])
        const resent = () => ledger.sent.filter((call) => refusedKeys.has(call.key ?? "")).length
        const sent = resent()

        yield* relay(ledger.layer)
        assert.equal(resent(), sent)
      }),
    ),
  ))

void test("a send records nothing on a claim it no longer holds", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const database = yield* Database
        const { business } = yield* createBusiness()
        const row = yield* postingOf((yield* paid(yield* linkOf(business.id))).id)

        // The stale pass's lease expired, and another pass took the row over.
        const stale = yield* leased(row.id)
        const current = yield* leased(row.id)

        const replies: ReadonlyArray<readonly [LedgerPostings.Outcome, (sent: Sent) => Reply]> = [
          ["posted", ({ payload }) => entry(payload, "jrn_stale")],
          ["refused", () => refusal(409, "account_closed")],
          ["retrying", () => "unreachable"],
        ]

        for (const [expected, reply] of replies) {
          assert.equal(yield* send(row, stale).pipe(Effect.provide(fakeLedger(reply).layer)), expected)

          const stored = yield* postingOf(row.paymentId ?? "")

          assert.deepEqual(
            [stored.state, stored.attempts, stored.journalRef, stored.errorCode, stored.claimId],
            ["created", 0, null, null, current],
            expected,
          )
        }

        const ledger = fakeLedger(({ payload }) => entry(payload, "jrn_current"))

        assert.equal(yield* send(row, current).pipe(Effect.provide(ledger.layer)), "posted")

        const posted = yield* postingOf(row.paymentId ?? "")

        assert.deepEqual([posted.state, posted.attempts, posted.journalRef], ["posted", 1, "jrn_current"])

        // Resolved once: the stale pass can't move it again either.
        yield* database.use((db) => db.update(ledgerPostings).set({ claimId: stale }).where(eq(ledgerPostings.id, row.id)))
        yield* send(row, stale).pipe(Effect.provide(fakeLedger(() => refusal(409, "account_closed")).layer))
        assert.equal((yield* postingOf(row.paymentId ?? "")).state, "posted")
      }),
    ),
  ))

// Committed, so claims on their own connections see each other's leases.
void test("a claim skips postings under another pass's lease, takes them once it expires, and never shares them", () =>
  runtime.runPromise(
    Effect.gen(function* () {
      const database = yield* Database
      const { business } = yield* createBusiness()
      const link = yield* linkOf(business.id)
      const ids = [(yield* paid(link)).id, (yield* paid(link)).id, (yield* paid(link)).id]
      const rows = yield* Effect.forEach(ids, postingOf)
      const ours = new Set(rows.map((row) => row.id))

      const claim = Effect.gen(function* () {
        const postings = yield* LedgerPostings.Service
        const claimed = yield* postings.claim(1_000)

        return claimed.postings.map((posting): string => posting.id).filter((id) => ours.has(id))
      }).pipe(Effect.provide(fakeLedger(() => "unreachable").layer))

      const expire = (id: string) =>
        database.use((db) =>
          db
            .update(ledgerPostings)
            .set({ claimedUntil: sql`now() - interval '1 second'` })
            .where(eq(ledgerPostings.id, id)),
        )

      yield* Effect.gen(function* () {
        // Oldest first.
        assert.deepEqual(yield* claim, rows.map((row) => row.id))

        // A pass that died after claiming holds them until the lease expires.
        assert.deepEqual(yield* claim, [])

        yield* expire(rows[1]?.id ?? "")
        assert.deepEqual(yield* claim, [rows[1]?.id])

        yield* Effect.forEach(ids, (id) => Effect.andThen(postingOf(id), (row) => expire(row.id)))

        const [one, other] = yield* Effect.all([claim, claim], { concurrency: 2 })

        assert.deepEqual(one.filter((id) => other.includes(id)), [])
        assert.deepEqual(new Set([...one, ...other]), ours)
      }).pipe(
        // Leaves nothing for other tests' relays to send.
        Effect.ensuring(
          database.use((db) =>
            db.update(ledgerPostings).set({ state: "refused", errorCode: "test_cleanup" }).where(inArray(ledgerPostings.id, [...ours])),
          ),
        ),
      )
    }),
  ))

void test("a pass whose claim fails sends nothing", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const { business } = yield* createBusiness()
        const row = yield* postingOf((yield* paid(yield* linkOf(business.id))).id)
        const ledger = fakeLedger(({ payload }) => entry(payload, "jrn_unsent"))

        const exit = yield* Effect.exit(relay(ledger.layer.pipe(Layer.provide(failingAfter(0)))))

        assert.ok(Exit.hasDies(exit))
        assert.deepEqual(ledger.sent, [])

        const stored = yield* postingOf(row.paymentId ?? "")

        assert.deepEqual([stored.state, stored.attempts, stored.claimId], ["created", 0, null])
      }),
    ),
  ))

void test("a posting the ledger took but plane never recorded is posted from the replay once its lease expires", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const database = yield* Database
        const { business } = yield* createBusiness()
        const row = yield* postingOf((yield* paid(yield* linkOf(business.id))).id)

        // The ledger keeps the first entry per key and replays it.
        const posted = new Map<string, string>()

        const ledger = fakeLedger(({ payload, key }) => {
          const journalRef = posted.get(key ?? "") ?? `jrn_${ulid()}`

          posted.set(key ?? "", journalRef)

          return entry(payload, journalRef)
        })

        // Only the claim gets through: recording and releasing both fail.
        assert.ok(Exit.hasDies(yield* Effect.exit(relay(ledger.layer.pipe(Layer.provide(failingAfter(1)))))))

        const unrecorded = yield* postingOf(row.paymentId ?? "")
        const journalRef = posted.get(row.id)

        assert.ok(journalRef !== undefined, "the ledger posted it")
        assert.deepEqual([unrecorded.state, unrecorded.attempts], ["created", 0])
        assert.equal((yield* leasesOf([row.id])).get(row.id)?.ended, false, "still claimed")

        // Leased, it waits; expired, the next pass gets the replay.
        yield* relay(ledger.layer)
        assert.equal((yield* postingOf(row.paymentId ?? "")).state, "created")

        yield* database.use((db) =>
          db.update(ledgerPostings).set({ claimedUntil: sql`now() - interval '1 second'` }).where(eq(ledgerPostings.id, row.id)),
        )
        yield* relay(ledger.layer)

        const stored = yield* postingOf(row.paymentId ?? "")

        assert.deepEqual([stored.state, stored.journalRef, stored.attempts], ["posted", journalRef, 1])
      }),
    ),
  ))

void test("a ledger slower than the send timeout leaves the posting to retry, and the resend posts the replay", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const { business } = yield* createBusiness()
        const link = yield* linkOf(business.id)
        const ids = [(yield* paid(link)).id, (yield* paid(link)).id]
        const [slow, behind] = yield* Effect.forEach(ids, postingOf)

        // It posts at once but answers the first time only after the relay
        // gave up on it.
        let answered = false

        const ledger = fakeLedger(({ payload, key }) => {
          const answer = entry(payload, `jrn_${key}`)

          if (key !== slow?.id || answered) {
            return answer
          }

          answered = true

          return Effect.as(Effect.sleep(Duration.sum(LedgerPostings.sendTimeout, Duration.seconds(1))), answer)
        })

        assert.ok(Predicate.isTagged(yield* Effect.flip(relay(ledger.layer)), "LedgerPostings.UnavailableError"))

        const after = new Map((yield* postingsOf(ids)).map((row) => [row.id, [row.state, row.attempts]]))

        assert.deepEqual(after.get(slow?.id ?? ""), ["created", 1])
        assert.deepEqual(after.get(behind?.id ?? ""), ["created", 0])
        const leases = yield* leasesOf([slow?.id ?? "", behind?.id ?? ""])

        assert.deepEqual([...leases.values()].map((lease) => lease.ended), [true, true], "released")

        yield* relay(ledger.layer)

        const stored = yield* postingOf(slow?.paymentId ?? "")

        assert.deepEqual([stored.state, stored.journalRef, stored.attempts], ["posted", `jrn_${slow?.id}`, 2])
      }),
    ),
  ))

void test("an interrupted pass releases what it left unsent", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const { business } = yield* createBusiness()
        const link = yield* linkOf(business.id)
        const ids = [(yield* paid(link)).id, (yield* paid(link)).id]
        const [first] = yield* Effect.forEach(ids, postingOf)
        const calling = yield* Deferred.make<void>()

        const ledger = fakeLedger(({ payload, key }) =>
          key === first?.id ? Effect.andThen(Deferred.succeed(calling, undefined), Effect.never) : entry(payload, `jrn_${key}`),
        )

        const pass = yield* Effect.forkChild(relay(ledger.layer))

        yield* Deferred.await(calling)
        yield* Fiber.interrupt(pass)

        const rows = yield* postingsOf(ids)
        const leases = yield* leasesOf(rows.map((row) => row.id))

        for (const row of rows) {
          assert.deepEqual([row.state, leases.get(row.id)?.ended], ["created", true])
          assert.ok(row.claimId !== null)
        }
      }),
    ),
  ))

void test("a pass interrupted while claiming still releases what the claim took", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const { business } = yield* createBusiness()
        const link = yield* linkOf(business.id)
        const ids = [(yield* paid(link)).id, (yield* paid(link)).id]
        const rows = yield* postingsOf(ids)
        const ledger = fakeLedger(({ payload, key }) => entry(payload, `jrn_${key}`))
        const [sent, go, done] = yield* Effect.all([Deferred.make<void>(), Deferred.make<void>(), Deferred.make<void>()])

        const pass = yield* Effect.forkChild(relay(ledger.layer.pipe(Layer.provide(heldFirst(sent, go, done)))))

        yield* Deferred.await(sent)

        // Interrupted while the claim is on the wire; the claim then lands.
        const interrupting = yield* Effect.forkChild(Fiber.interrupt(pass))

        yield* Effect.sleep("20 millis")
        yield* Deferred.succeed(go, undefined)
        yield* Fiber.join(interrupting)
        yield* Deferred.await(done)

        assert.deepEqual(ledger.sent, [])

        const leases = yield* leasesOf(rows.map((row) => row.id))

        for (const row of rows) {
          const lease = leases.get(row.id)

          assert.ok(lease?.claimId !== null, "claimed")
          assert.equal(lease?.ended, true, "released")
        }
      }),
    ),
  ))

// Committed, so another connection can see what the relay has recorded and
// what it still holds.
void test("the relay holds no connection or lock while the ledger answers", () =>
  runtime.runPromise(
    Effect.gen(function* () {
      const database = yield* Database
      const { business } = yield* createBusiness()
      const link = yield* linkOf(business.id)
      const ids = [(yield* paid(link)).id, (yield* paid(link)).id]
      const [first, second] = yield* Effect.forEach(ids, postingOf)

      // Asked from a pool of its own, so it can't join anything the relay
      // has open.
      const seen = Effect.gen(function* () {
        const elsewhere = yield* Database

        const recorded = yield* elsewhere.use((db) =>
          db.select({ state: ledgerPostings.state }).from(ledgerPostings).where(eq(ledgerPostings.id, first?.id ?? "")),
        )

        const lockable = yield* Effect.exit(
          elsewhere.transaction(
            elsewhere.use((db) =>
              db
                .select({ id: ledgerPostings.id })
                .from(ledgerPostings)
                .where(eq(ledgerPostings.id, second?.id ?? ""))
                .for("update", { noWait: true }),
            ),
          ),
        )

        return [recorded[0]?.state, Exit.isSuccess(lockable)] as const
      }).pipe(Effect.provide(DatabaseLayer), Effect.orDie)

      const checks: Array<readonly [string | undefined, boolean]> = []

      const ledger = fakeLedger(({ payload, key }) => {
        const answer = entry(payload, `jrn_${key}`)

        return key === second?.id
          ? seen.pipe(
            Effect.tap((check) => Effect.sync(() => checks.push(check))),
            Effect.as(answer),
          )
          : answer
      })

      yield* relay(ledger.layer).pipe(
        Effect.ensuring(
          database.use((db) =>
            db
              .update(ledgerPostings)
              .set({ state: "refused", errorCode: "test_cleanup" })
              .where(and(inArray(ledgerPostings.id, [first?.id ?? "", second?.id ?? ""]), eq(ledgerPostings.state, "created"))),
          ),
        ),
      )

      assert.deepEqual(checks, [["posted", true]])
      assert.deepEqual((yield* postingsOf(ids)).map((row) => row.state), ["posted", "posted"])
    }),
  ))

void test("settling, settled and attention agree across rows, filters and totals, and a payment shows its timeline", () =>
  runtime.runPromise(
    Testing.rolledBack(
      Effect.gen(function* () {
        const database = yield* Database
        const service = yield* Payments.Service
        const { business } = yield* createBusiness()
        const link = yield* linkOf(business.id)
        const settling = yield* paid(link)
        const settled = yield* paid(link)
        const attention = yield* paid(link)
        const failed = yield* paid(link, "failed")
        const recordedAt = DateTime.toDate(DateTime.makeUnsafe("2026-10-26T14:02:00Z"))

        const set = (paymentId: string, values: Partial<typeof ledgerPostings.$inferInsert>) =>
          database.use((db) => db.update(ledgerPostings).set(values).where(eq(ledgerPostings.paymentId, paymentId)))

        yield* set(settled.id, { state: "posted", journalRef: "jrn_settled", recordedAt })
        yield* set(attention.id, { state: "refused", errorCode: "account_closed", lastAttemptAt: recordedAt })

        const expected = [
          ["settling", [settling.id]],
          ["settled", [settled.id]],
          ["attention", [attention.id]],
          ["failed", [failed.id]],
        ] as const

        const all = yield* service.listPayments(business.id, { linkId: null, state: null, before: null })

        assert.deepEqual(
          Object.fromEntries(all.payments.map((payment) => [payment.id, [payment.status, payment.state]])),
          {
            [settling.id]: ["succeeded", "settling"],
            [settled.id]: ["succeeded", "settled"],
            [attention.id]: ["succeeded", "attention"],
            [failed.id]: ["failed", "failed"],
          },
        )
        assert.deepEqual(
          [all.stats.succeeded, all.stats.settling, all.stats.settled, all.stats.attention, all.stats.failed],
          [3, 1, 1, 1, 1],
        )
        assert.equal(all.stats.collected, 2_500_000n)
        assert.equal(all.stats.settlingAmount, 2_500_000n)

        const row = all.payments.find((payment) => payment.id === settled.id)

        assert.deepEqual([row?.settledAt, row?.journalRef], [recordedAt, "jrn_settled"])

        for (const [state, ids] of expected) {
          const page = yield* service.listPayments(business.id, { linkId: link.id, state, before: null })

          assert.deepEqual(page.payments.map((payment) => payment.id), ids, state)
          assert.deepEqual(
            [page.stats.settling, page.stats.settled, page.stats.attention],
            [state === "settling" ? 1 : 0, state === "settled" ? 1 : 0, state === "attention" ? 1 : 0],
            state,
          )
          assert.equal(page.stats.collected, state === "settled" ? 2_500_000n : 0n, state)
        }

        const overview = yield* service.listLinks(business.id)

        assert.deepEqual(
          [overview.totals.settling, overview.totals.settled, overview.totals.attention, overview.totals.collected],
          [1, 1, 1, 2_500_000n],
        )

        const timeline = (id: string) => Effect.map(service.getPayment(business.id, id), (detail) => detail.timeline)

        const paidAt = (payment: Payments.Payment) => new Payments.Paid({ at: payment.completedAt ?? recordedAt })

        assert.deepEqual(yield* timeline(settling.id), [paidAt(settling)])
        assert.deepEqual(yield* timeline(settled.id), [
          paidAt(settled),
          new Payments.Settled({ at: recordedAt, journalRef: "jrn_settled" }),
        ])
        assert.deepEqual(yield* timeline(attention.id), [
          paidAt(attention),
          new Payments.Refused({ at: recordedAt, errorCode: "account_closed" }),
        ])
        assert.deepEqual(yield* timeline(failed.id), [])

        const detail = yield* service.getPayment(business.id, settled.id)

        assert.deepEqual(detail.payment, row)

        // Another business's payment, or no payment at all, is not found.
        const other = yield* createBusiness()

        for (const [businessId, id] of [[other.business.id, settled.id], [business.id, `pay_${ulid()}`]] as const) {
          assert.ok(Predicate.isTagged(yield* Effect.flip(service.getPayment(businessId, id)), "Payments.PaymentNotFoundError"))
        }
      }),
    ),
  ))
