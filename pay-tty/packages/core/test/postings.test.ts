import assert from "node:assert/strict"
import { test } from "node:test"

import { PostJournalEntryRequestJson } from "@pay-tty/ledger-client"
import { and, eq, inArray } from "drizzle-orm"
import { Cause, ConfigProvider, DateTime, Deferred, Effect, Exit, Fiber, Layer, Predicate, Schema } from "effect"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientError from "effect/unstable/http/HttpClientError"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { ulid } from "ulid"

import { Business } from "../src/business/business.ts"
import { Database } from "../src/database/client.ts"
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
const fakeLedger = (reply: (sent: Sent) => Reply) => {
  const sent: Array<Sent> = []

  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      const web = yield* Effect.orDie(HttpClientRequest.toWeb(request))

      const payload = yield* Effect.orDie(
        Schema.decodeUnknownEffect(PostJournalEntryRequestJson)(yield* Effect.promise(() => web.json())),
      )

      const call = { key: web.headers.get("idempotency-key"), payload }

      sent.push(call)

      const answer = reply(call)

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

const send = (row: typeof ledgerPostings.$inferSelect) =>
  Effect.gen(function* () {
    const postings = yield* LedgerPostings.Service

    return yield* postings.send(asPosting(row))
  })

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
        assert.equal(posting.description, `Payment ${payment.id} via link ${link.id}`)
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

        // Back up: the rest go through, and a pass with nothing to send is quiet.
        const up = fakeLedger(({ payload, key }) => entry(payload, `jrn_${key}`))

        yield* relay(up.layer)
        assert.deepEqual((yield* postingsOf(ids)).map((row) => row.state), ["posted", "posted", "posted"])

        const sent = up.sent.length

        yield* relay(up.layer)
        assert.equal(up.sent.length, sent)
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

// Committed, so a second transaction can see the rows the first one locks.
void test("a claim skips postings another transaction holds", () =>
  runtime.runPromise(
    Effect.gen(function* () {
      const database = yield* Database
      const { business } = yield* createBusiness()
      const row = yield* postingOf((yield* paid(yield* linkOf(business.id))).id)

      const claim = Effect.gen(function* () {
        const postings = yield* LedgerPostings.Service

        return (yield* postings.claim(1_000)).map((posting): string => posting.id)
      }).pipe(Effect.provide(fakeLedger(() => "unreachable").layer))

      yield* Effect.gen(function* () {
        const claimed = yield* Deferred.make<ReadonlyArray<string>>()
        const release = yield* Deferred.make<void>()

        const holder = yield* Effect.forkChild(
          database.transaction(
            Effect.gen(function* () {
              yield* Deferred.succeed(claimed, yield* claim)
              yield* Deferred.await(release)
            }),
          ),
        )

        const held = yield* Deferred.await(claimed)
        const others = yield* database.transaction(claim)

        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(holder)

        assert.ok(held.includes(row.id))
        assert.ok(!others.includes(row.id))

        // Released, it is claimed again.
        assert.ok((yield* database.transaction(claim)).includes(row.id))
      }).pipe(
        // Leaves nothing for other tests' relays to send.
        Effect.ensuring(
          database.use((db) =>
            db.update(ledgerPostings).set({ state: "refused", errorCode: "test_cleanup" }).where(eq(ledgerPostings.id, row.id)),
          ),
        ),
      )
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
