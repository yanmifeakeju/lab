import assert from "node:assert/strict"
import { test } from "node:test"

import { PostJournalEntryRequestJson, ResolveJournalEntryRequestJson } from "@pay-tty/ledger-client"
import { eq, sql } from "drizzle-orm"
import { Cause, ConfigProvider, Duration, Effect, Exit, Layer, Logger, References, Schema } from "effect"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientError from "effect/unstable/http/HttpClientError"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { ulid } from "ulid"

import { Business } from "../src/business/business.ts"
import { Database } from "../src/database/client.ts"
import { LedgerClient } from "../src/ledger/client.ts"
import { RelayNudge } from "../src/ledger/nudge.ts"
import { LedgerPostings } from "../src/ledger/postings.ts"
import { Ledger } from "../src/ledger/slug.ts"
import { ledgerPostings } from "../src/ledger/sql.ts"
import { Payments } from "../src/payments/payments.ts"
import { PayoutDispatcher } from "../src/payouts/dispatcher.ts"
import { Payouts } from "../src/payouts/payouts.ts"
import { PayoutProvider } from "../src/payouts/provider.ts"
import { SimProvider } from "../src/payouts/providers/sim/adapter.ts"
import { payouts as payoutRows, payoutSettings } from "../src/payouts/sql.ts"
import { Principal } from "../src/principal/principal.ts"
import { ScriptedProvider } from "../src/testing/provider.ts"
import { Testing } from "../src/testing/testing.ts"
import { runtime } from "./runtime.ts"

const ngn = Ledger.Slug.make("ngn_ng")

const createBusiness = (open = true, countryCode: Business.Country = "NG") =>
  Effect.gen(function* () {
    const principals = yield* Principal.Service
    const businesses = yield* Business.Service

    const principal = yield* principals.ensure({ issuer: "payouts-test", subject: ulid() })
    const business = yield* businesses.create(principal.id, new Business.Details({ name: "Adaeze Studio", countryCode }))
    const accountRef = open ? yield* Testing.openAccount(business.id) : null

    return { id: business.id, accountRef }
  })

const gtbank = { bankCode: "058", accountNumber: "0123456789" } as const

// Destination account name defaults to the business name.
const toGtbank = new Payouts.Destination({ ...gtbank, accountName: "Adaeze Studio" })

const save = (businessId: Business.ID, change: { readonly mode: Payouts.Mode; readonly destination: Payouts.Change["destination"] }) =>
  Effect.gen(function* () {
    const service = yield* Payouts.Service

    return yield* service.changeSettings(businessId, ngn, new Payouts.Change(change))
  })

// Creates an active business configured for manual payouts to `gtbank`.
const payable = Effect.gen(function* () {
  const business = yield* createBusiness()

  yield* save(business.id, { mode: "manual", destination: gtbank })

  return business
})

const create = (businessId: Business.ID, amount: bigint) =>
  Effect.gen(function* () {
    const service = yield* Payouts.Service

    return yield* service.create(businessId, ngn, amount)
  })

const confirm = (businessId: Business.ID, id: string) =>
  Effect.gen(function* () {
    const service = yield* Payouts.Service

    return yield* service.confirm(businessId, id)
  })

// Creates and immediately confirms a payout draft.
const request = (businessId: Business.ID, amount: bigint) =>
  Effect.flatMap(create(businessId, amount), (payout) => confirm(businessId, payout.id))

const postingOf = (payoutId: string) =>
  Effect.gen(function* () {
    const database = yield* Database

    const rows = yield* database.use((db) => db.select().from(ledgerPostings).where(eq(ledgerPostings.payoutId, payoutId)))

    assert.equal(rows.length, 1)

    return rows[0] ?? assert.fail("no posting")
  })

type Answer = { readonly status: number; readonly body: object }

type Reply = Answer | "unreachable"

/** Resolution request captured by the fake ledger. */
interface Resolution {
  readonly journalRef: string
  readonly key: string | null
  readonly payload: ResolveJournalEntryRequestJson
}

const resolvedAs = ({ journalRef, payload }: Resolution): Reply => ({
  status: 201,
  body: {
    journal_ref: `jrn_${payload.action}`,
    pending_ref: journalRef,
    ledger_slug: payload.ledger,
    kind: "payout",
    pending_state: payload.action === "capture" ? "captured" : "voided",
    description: "Payout to GTBank ••••6789",
    created_at: "2026-11-10T09:05:00Z",
  },
})

// Stubs the ledger service at the `HttpClient` layer for entry posts (`reply`) and resolutions (`resolve`).
const fakeLedger = (
  reply: (payload: PostJournalEntryRequestJson) => Reply,
  resolve: (resolution: Resolution) => Reply = resolvedAs,
) => {
  const sent: Array<PostJournalEntryRequestJson> = []
  const resolutions: Array<Resolution> = []

  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      const web = yield* Effect.orDie(HttpClientRequest.toWeb(request))
      const path = new URL(web.url).pathname
      const body: unknown = yield* Effect.promise(() => web.json())
      let answer: Reply

      if (path.endsWith("/resolve")) {
        const resolution = {
          journalRef: decodeURIComponent(path.slice("/entries/".length, -"/resolve".length)),
          key: web.headers.get("idempotency-key"),
          payload: yield* Effect.orDie(Schema.decodeUnknownEffect(ResolveJournalEntryRequestJson)(body)),
        }

        resolutions.push(resolution)
        answer = resolve(resolution)
      } else {
        const payload = yield* Effect.orDie(Schema.decodeUnknownEffect(PostJournalEntryRequestJson)(body))

        sent.push(payload)
        answer = reply(payload)
      }

      if (answer === "unreachable") {
        return yield* new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, description: "connection refused" }),
        })
      }

      return HttpClientResponse.fromWeb(request, Response.json(answer.body, { status: answer.status }))
    }),
  )

  return {
    sent,
    resolutions,
    layer: LedgerPostings.layer.pipe(
      Layer.provide(LedgerClient.layer),
      Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ LEDGER_BASE_URL: "http://ledger.test" }))),
      Layer.orDie,
    ),
  }
}

const held = (payload: PostJournalEntryRequestJson): Reply => ({
  status: 201,
  body: {
    journal_ref: "jrn_hold",
    ledger_slug: payload.ledger,
    kind: payload.kind,
    state: payload.pending === true ? "pending" : "posted",
    description: payload.description,
    created_at: "2026-11-10T09:00:00Z",
  },
})

const insufficient = (): Reply => ({
  status: 409,
  body: { message: "Insufficient funds.", error: { code: "insufficient_funds" } },
})

// Leases and sends the posting for `payoutId` against `ledger`.
const relayed = (payoutId: string, ledger: ReturnType<typeof fakeLedger>) =>
  Effect.gen(function* () {
    const database = yield* Database
    const row = yield* postingOf(payoutId)
    const claim = LedgerPostings.ClaimID.make(`lclaim_${ulid()}`)

    yield* database.use((db) =>
      db
        .update(ledgerPostings)
        .set({ claimId: claim, claimedUntil: sql`now() + interval '1 minute'` })
        .where(eq(ledgerPostings.id, row.id)),
    )

    return yield* Effect.gen(function* () {
      const postings = yield* LedgerPostings.Service

      return yield* postings.send(claim, LedgerPostings.postingOf(row))
    }).pipe(Effect.provide(ledger.layer))
  })

const get = (businessId: Business.ID, id: string) =>
  Effect.gen(function* () {
    const service = yield* Payouts.Service

    return yield* service.get(businessId, id)
  })

// Counts `RelayNudge.nudge` calls made during a test.
let nudges = 0

const countingNudge = Layer.succeed(RelayNudge.Service, RelayNudge.Service.of({
  nudge: Effect.sync(() => {
    nudges += 1
  }),
  next: () => Effect.void,
}))

type Services = Payouts.Service | Payments.Service | Business.Service | Principal.Service | Database

const run = <A, E>(effect: Effect.Effect<A, E, Services>) =>
  runtime.runPromise(
    Testing.rolledBack(effect.pipe(Effect.provide(Payouts.layer.pipe(Layer.provide(countingNudge))))),
  )

void test("an open account reads as manual with no destination until saved, and every save needs one", () =>
  run(
    Effect.gen(function* () {
      const service = yield* Payouts.Service
      const unopened = yield* createBusiness(false)
      const { id } = yield* createBusiness()

      assert.ok(Exit.hasFails(yield* Effect.exit(service.settings(unopened.id, ngn))))

      const fresh = yield* service.settings(id, ngn)

      assert.deepEqual(
        [fresh.mode, fresh.destination, fresh.currencyCode, fresh.scale, fresh.updatedAt],
        ["manual", null, "NGN", 2, null],
      )

      assert.deepEqual(
        yield* Effect.flip(save(unopened.id, { mode: "manual", destination: gtbank })),
        new Payouts.SettingsNotFoundError({ businessId: unopened.id, ledger: ngn }),
      )

      const first = yield* save(id, { mode: "manual", destination: gtbank })

      assert.deepEqual([first.mode, first.destination], ["manual", toGtbank])
      assert.ok(first.updatedAt !== null)

      // A second save replaces the first.
      const saved = yield* save(id, { mode: "automatic", destination: gtbank })

      assert.equal(saved.mode, "automatic")
      assert.deepEqual(saved.destination, toGtbank)

      const decode = Schema.decodeUnknownExit(Payouts.Change)

      assert.ok(Exit.isFailure(decode({ mode: "manual", destination: null })))
      assert.ok(Exit.isFailure(decode({ mode: "automatic", destination: null })))

      assert.ok(Exit.isFailure(decode({ mode: "manual", destination: { ...gtbank, bankCode: "58" } })))

      // A well-formed code the ledger's currency doesn't list.
      assert.deepEqual(
        yield* Effect.flip(service.changeSettings(id, ngn, new Payouts.Change({ mode: "manual", destination: { ...gtbank, bankCode: "999" } }))),
        new Payouts.BankError({ bankCode: "999", currency: "NGN" }),
      )
      assert.ok(Exit.isSuccess(decode({ mode: "manual", destination: gtbank })))
      assert.throws(() => new Payouts.Change({ mode: "manual", destination: { ...gtbank, accountNumber: "12345" } }))

      // The database holds the same line.
      const database = yield* Database

      const forced = yield* Testing.attempt(
        database.use((db) =>
          db.update(payoutSettings).set({ bankCode: sql`null` }).where(eq(payoutSettings.businessId, id)),
        ),
      )

      assert.ok(Exit.isFailure(forced))
    }),
  ))

void test("payouts follow the ledger's currency: its banks and minimum, and none where it has no rules", () =>
  run(
    Effect.gen(function* () {
      const service = yield* Payouts.Service
      const { id } = yield* createBusiness()

      assert.ok((yield* service.banks(id, ngn)).some((bank) => bank.code === "058"))
      assert.equal((yield* service.settings(id, ngn)).minimum, 10_000n)

      // The seed has no US ledger; this one has no payout rules.
      const usd = Ledger.Slug.make("usd_payouts_test")

      yield* Testing.addLedger(usd, "USD", 2, "US")
      yield* Testing.makeCountryDefault(usd)

      const elsewhere = yield* createBusiness(true, "US")
      const unavailable = new Payouts.UnavailableError({ businessId: elsewhere.id, ledger: usd, currency: "USD" })

      assert.deepEqual(yield* Effect.flip(service.settings(elsewhere.id, usd)), unavailable)
      assert.deepEqual(yield* Effect.flip(service.banks(elsewhere.id, usd)), unavailable)
      assert.deepEqual(
        yield* Effect.flip(service.changeSettings(elsewhere.id, usd, new Payouts.Change({ mode: "manual", destination: gtbank }))),
        unavailable,
      )
      assert.deepEqual(
        yield* Effect.flip(service.create(elsewhere.id, usd, 2_500_000n)),
        unavailable,
      )
    }),
  ))

void test("a create moves no money: the payout is created with the saved destination, and nothing is posted", () =>
  run(
    Effect.gen(function* () {
      const { id } = yield* payable
      const before = nudges
      const payout = yield* create(id, 2_500_000n)

      assert.match(payout.id, /^pout_[0-9A-HJKMNP-TV-Z]{26}$/)
      assert.deepEqual(
        [payout.status, payout.trigger, payout.amount, payout.journalRef, payout.completedAt],
        ["created", "manual", 2_500_000n, null, null],
      )
      assert.deepEqual(payout.destination, toGtbank)
      assert.equal(nudges, before)

      const database = yield* Database

      assert.deepEqual(yield* database.use((db) => db.select().from(ledgerPostings).where(eq(ledgerPostings.payoutId, payout.id))), [])

      const [row] = yield* database.use((db) => db.select().from(payoutRows).where(eq(payoutRows.id, payout.id)))

      assert.equal(row?.idempotencyKey, null)
    }),
  ))

void test("a confirm commits the payout with its hold: payable to payouts_clearing, pending", () =>
  run(
    Effect.gen(function* () {
      const { id, accountRef } = yield* payable
      const before = nudges
      const { payout, confirmed } = yield* request(id, 2_500_000n)

      assert.ok(confirmed)
      assert.equal(nudges, before + 1, "the relay is nudged")
      assert.match(payout.id, /^pout_[0-9A-HJKMNP-TV-Z]{26}$/)
      assert.deepEqual(
        [payout.status, payout.trigger, payout.amount, payout.reason, payout.journalRef],
        ["requested", "manual", 2_500_000n, null, null],
      )
      assert.deepEqual(payout.destination, toGtbank)

      const posting = yield* postingOf(payout.id)

      assert.deepEqual(
        [posting.kind, posting.description, posting.pending, posting.state, posting.paymentId, posting.ledger],
        ["payout", "Payout to GTBank ••••6789", true, "created", null, "ngn_ng"],
      )
      assert.deepEqual(posting.lines, [
        {
          debit_account_ref: accountRef,
          credit_account_ref: "acct_test_payouts_clearing",
          amount: "2500000",
          purpose: "payout",
        },
      ])
    }),
  ))

void test("the relay sends the hold as a pending entry, and the payout is held once the ledger records it", () =>
  run(
    Effect.gen(function* () {
      const { id, accountRef } = yield* payable
      const { payout } = yield* request(id, 2_500_000n)
      const ledger = fakeLedger(held)

      assert.equal(yield* relayed(payout.id, ledger), "posted")
      assert.deepEqual(ledger.sent, [{
        ledger: "ngn_ng",
        kind: "payout",
        description: "Payout to GTBank ••••6789",
        pending: true,
        lines: [{ debit_account_ref: accountRef, credit_account_ref: "acct_test_payouts_clearing", amount: 2_500_000, purpose: "payout" }],
      }])

      const posting = yield* postingOf(payout.id)

      assert.deepEqual([posting.state, posting.journalRef, posting.resolutionRef], ["pending", "jrn_hold", null])

      const shown = yield* get(id, payout.id)

      assert.deepEqual([shown.status, shown.journalRef, shown.reason, shown.completedAt], ["held", "jrn_hold", null, null])
    }),
  ))

void test("a ledger that posts a hold outright takes the posting out of the queue, and the payout needs attention", () =>
  run(
    Effect.gen(function* () {
      const { id } = yield* payable
      const { payout } = yield* request(id, 2_500_000n)

      const ignoresPending = fakeLedger((payload) => ({
        status: 201,
        body: {
          journal_ref: "jrn_hold",
          ledger_slug: payload.ledger,
          kind: payload.kind,
          state: "posted",
          description: payload.description,
          created_at: "2026-11-10T09:00:00Z",
        },
      }))

      assert.equal(yield* relayed(payout.id, ignoresPending), "refused")

      const posting = yield* postingOf(payout.id)

      assert.deepEqual([posting.state, posting.errorCode, posting.journalRef], ["refused", "unexpected_state", "jrn_hold"])
      const shown = yield* get(id, payout.id)

      // Its entry isn't a hold, so the payout doesn't name it as one.
      assert.deepEqual([shown.status, shown.journalRef, shown.ledgerMismatch], ["attention", "jrn_hold", false])
    }),
  ))

void test("insufficient funds rejects the payout with its reason, and frees the business to ask again", () =>
  run(
    Effect.gen(function* () {
      const { id } = yield* payable
      const { payout } = yield* request(id, 2_500_000n)

      assert.equal(yield* relayed(payout.id, fakeLedger(insufficient)), "refused")

      const posting = yield* postingOf(payout.id)
      const shown = yield* get(id, payout.id)

      assert.deepEqual([posting.state, posting.errorCode], ["refused", "insufficient_funds"])
      assert.deepEqual([shown.status, shown.reason, shown.journalRef], ["rejected", "insufficient_funds", null])
      assert.ok(shown.completedAt !== null)

      assert.ok((yield* request(id, 1_000_000n)).confirmed)
    }),
  ))

void test("an idempotency conflict leaves the payout needing attention, with no reason shown and nothing freed", () =>
  run(
    Effect.gen(function* () {
      const { id } = yield* payable
      const { payout } = yield* request(id, 2_500_000n)

      // The ledger may already hold an entry under this posting.
      const conflicting = fakeLedger(() => ({
        status: 409,
        body: { message: "Idempotency conflict.", error: { code: "idempotency_conflict" } },
      }))

      assert.equal(yield* relayed(payout.id, conflicting), "refused")

      const shown = yield* get(id, payout.id)

      assert.deepEqual([shown.status, shown.reason, shown.completedAt], ["attention", null, null])
    }),
  ))

void test("a refusal that took no hold rejects the payout without a reason, and frees the business to ask again", () =>
  run(
    Effect.gen(function* () {
      const { id } = yield* payable
      const { payout } = yield* request(id, 2_500_000n)

      const closed = fakeLedger(() => ({
        status: 409,
        body: { message: "The account is closed.", error: { code: "account_closed" } },
      }))

      assert.equal(yield* relayed(payout.id, closed), "refused")

      const shown = yield* get(id, payout.id)

      assert.deepEqual([shown.status, shown.reason], ["rejected", null])
      assert.ok(shown.completedAt !== null)
    }),
  ))

// A ledger with `available` free in the business's account: each hold takes
// from it, and one it can't cover is refused.
const funded = (available: bigint) => {
  let free = available

  return (payload: PostJournalEntryRequestJson): Reply => {
    const amount = BigInt(payload.lines[0]?.amount ?? 0)

    if (amount > free) {
      return insufficient()
    }

    free -= amount

    return held(payload)
  }
}

const nth = <A>(items: ReadonlyArray<A>, index: number) => items[index] ?? assert.fail(`no item ${index}`)

void test("several payouts are in flight at once, and the ledger refuses the hold the balance can't cover", () =>
  run(
    Effect.gen(function* () {
      const { id } = yield* payable
      const ledger = fakeLedger(funded(3_000_000n))
      const drafts = [yield* create(id, 1_500_000n), yield* create(id, 1_000_000n), yield* create(id, 1_000_000n)]

      for (const draft of drafts) {
        assert.ok((yield* confirm(id, draft.id)).confirmed)
      }

      for (const draft of drafts) {
        yield* relayed(draft.id, ledger)
      }

      const shown = yield* Effect.forEach(drafts, (draft) => get(id, draft.id))

      assert.deepEqual(shown.map((payout) => [payout.status, payout.reason]), [
        ["held", null],
        ["held", null],
        ["rejected", "insufficient_funds"],
      ])

      // A refused hold is final: confirming again returns it as it stands.
      const again = yield* confirm(id, nth(drafts, 2).id)

      assert.deepEqual([again.confirmed, again.payout.status], [false, "rejected"])
    }),
  ))

void test("a business holds at most five created payouts open; expired and confirmed ones don't count", () =>
  run(
    Effect.gen(function* () {
      const { id } = yield* payable
      const other = yield* payable
      const drafts: Array<Payouts.Payout> = []

      for (let index = 0; index < Payouts.draftLimit; index++) {
        drafts.push(yield* create(id, 10_000n))
      }

      const full = new Payouts.DraftsFullError({ businessId: id, ledger: ngn })

      assert.deepEqual(yield* Effect.flip(create(id, 10_000n)), full)

      // Another business's are its own.
      assert.equal((yield* create(other.id, 10_000n)).status, "created")

      // Past its lifetime a draft is expired, whether or not it is marked yet.
      yield* Testing.createdAgo(nth(drafts, 0).id, Duration.seconds(100))
      yield* create(id, 10_000n)

      assert.deepEqual(yield* Effect.flip(create(id, 10_000n)), full)

      yield* Testing.createdAgo(nth(drafts, 1).id, Duration.seconds(100))
      yield* confirm(id, nth(drafts, 2).id)
      yield* create(id, 10_000n)
      yield* create(id, 10_000n)

      assert.deepEqual(yield* Effect.flip(create(id, 10_000n)), full)
    }),
  ))

void test("a created payout not confirmed within ninety seconds expires, and confirm moves no money on it", () =>
  run(
    Effect.gen(function* () {
      const { id } = yield* payable
      const fresh = yield* create(id, 2_500_000n)

      yield* Testing.createdAgo(fresh.id, Duration.seconds(80))

      assert.ok((yield* confirm(id, fresh.id)).confirmed, "still in time")

      const stale = yield* create(id, 2_500_000n)
      const expired = new Payouts.ExpiredError({ id: stale.id })
      const before = nudges

      yield* Testing.createdAgo(stale.id, Duration.seconds(100))

      // Read before anything marks it, it already says expired, as of its expiry.
      const unmarked = yield* get(id, stale.id)

      assert.deepEqual([unmarked.status, unmarked.expiresAt], ["expired", null])

      assert.deepEqual(yield* Effect.flip(confirm(id, stale.id)), expired)
      assert.equal(nudges, before)

      const shown = yield* get(id, stale.id)

      assert.deepEqual([shown.status, shown.journalRef], ["expired", null])
      // Marked, it keeps the time it expired, not when the mark ran.
      assert.ok(shown.completedAt !== null)
      assert.deepEqual(shown.completedAt, unmarked.completedAt)

      const database = yield* Database

      assert.deepEqual(yield* database.use((db) => db.select().from(ledgerPostings).where(eq(ledgerPostings.payoutId, stale.id))), [])

      // Expired is final.
      assert.deepEqual(yield* Effect.flip(confirm(id, stale.id)), expired)
    }),
  ))

void test("confirming again returns the payout as it stands, with one hold", () =>
  run(
    Effect.gen(function* () {
      const { id } = yield* payable
      const other = yield* payable
      const draft = yield* create(id, 2_500_000n)

      // Another business's payout is as unknown as one that doesn't exist.
      assert.equal((yield* Effect.flip(confirm(other.id, draft.id)))._tag, "Payouts.PayoutNotFoundError")

      const first = yield* confirm(id, draft.id)
      const before = nudges
      const again = yield* confirm(id, draft.id)

      assert.deepEqual([first.confirmed, again.confirmed, again.payout.status], [true, false, "requested"])
      assert.equal(nudges, before, "a repeat moves nothing")

      // Exactly one hold.
      yield* postingOf(draft.id)
      yield* relayed(draft.id, fakeLedger(held))

      const repeat = yield* confirm(id, draft.id)

      assert.deepEqual([repeat.confirmed, repeat.payout.status, repeat.payout.journalRef], [false, "held", "jrn_hold"])
    }),
  ))

void test("automatic mode refuses manual payouts, at create and at confirm, and no saved destination is no payout account", () =>
  run(
    Effect.gen(function* () {
      const bare = yield* createBusiness()

      assert.deepEqual(
        yield* Effect.flip(create(bare.id, 2_500_000n)),
        new Payouts.NoPayoutAccountError({ businessId: bare.id, ledger: ngn }),
      )

      const { id } = yield* createBusiness()

      yield* save(id, { mode: "automatic", destination: gtbank })

      assert.deepEqual(
        yield* Effect.flip(create(id, 2_500_000n)),
        new Payouts.AutomaticError({ businessId: id, ledger: ngn }),
      )

      const unopened = yield* createBusiness(false)

      assert.deepEqual(
        yield* Effect.flip(create(unopened.id, 2_500_000n)),
        new Payouts.SettingsNotFoundError({ businessId: unopened.id, ledger: ngn }),
      )

      const database = yield* Database

      assert.equal(
        (yield* database.use((db) => db.select().from(payoutRows).where(eq(payoutRows.businessId, id)))).length,
        0,
      )

      // Switched after the payout was created: it is cancelled, and moves nothing.
      const switched = yield* payable
      const draft = yield* create(switched.id, 2_500_000n)

      yield* save(switched.id, { mode: "automatic", destination: gtbank })

      assert.deepEqual(
        yield* Effect.flip(confirm(switched.id, draft.id)),
        new Payouts.AutomaticError({ businessId: switched.id, ledger: ngn }),
      )
      assert.equal((yield* get(switched.id, draft.id)).status, "cancelled")
      // Cancelled is final.
      assert.deepEqual(yield* Effect.flip(confirm(switched.id, draft.id)), new Payouts.CancelledError({ id: draft.id }))
    }),
  ))

void test("a saved bank no longer listed takes no payouts until a listed one is saved", () =>
  run(
    Effect.gen(function* () {
      const { id } = yield* payable
      const database = yield* Database

      // As if the bank were dropped from the list after it was saved.
      yield* database.use((db) => db.update(payoutSettings).set({ bankCode: "999" }).where(eq(payoutSettings.businessId, id)))

      assert.deepEqual(
        yield* Effect.flip(create(id, 2_500_000n)),
        new Payouts.NoPayoutAccountError({ businessId: id, ledger: ngn }),
      )
    }),
  ))

void test("a payout is at least ₦100.00", () =>
  run(
    Effect.gen(function* () {
      const { id } = yield* payable

      assert.equal((yield* Effect.flip(create(id, 9_999n)))._tag, "Payouts.AmountError")
      assert.equal((yield* create(id, 10_000n)).status, "created")
    }),
  ))

void test("confirmed payouts list newest first in pages, and each is read only by its own business", () =>
  run(
    Effect.gen(function* () {
      const service = yield* Payouts.Service
      const { id } = yield* payable
      const other = yield* payable
      const requested: Array<string> = []

      for (let index = 0; index < Payouts.pageSize + 1; index++) {
        const { payout } = yield* request(id, 10_000n + BigInt(index))

        requested.push(payout.id)
      }

      const first = yield* service.list(id, null)

      assert.equal(first.payouts.length, Payouts.pageSize)
      assert.equal(first.payouts[0]?.id, requested.at(-1))
      assert.ok(first.next !== null)

      const second = yield* service.list(id, first.next)

      assert.deepEqual(second.payouts.map((payout) => payout.id), [requested[0]])
      assert.equal(second.next, null)

      // Drafts aren't listed, open or expired, but each is still read by its ID.
      const open = yield* create(id, 10_000n)
      const lapsed = yield* create(id, 10_000n)

      yield* Testing.createdAgo(lapsed.id, Duration.seconds(100))
      yield* dispatch(ScriptedProvider.scripted().layer)

      assert.deepEqual((yield* service.list(id, null)).payouts[0]?.id, requested.at(-1))
      assert.equal((yield* get(id, open.id)).status, "created")
      assert.equal((yield* get(id, lapsed.id)).status, "expired")

      assert.deepEqual((yield* service.list(other.id, null)).payouts, [])
      assert.equal((yield* Effect.flip(service.list(id, Payouts.Cursor.make("nonsense"))))._tag, "Payouts.CursorError")
      assert.equal((yield* Effect.flip(get(other.id, requested[0] ?? "")))._tag, "Payouts.PayoutNotFoundError")
    }),
  ))

void test("a payout pays the destination saved when it was created, even once another is saved", () =>
  run(
    Effect.gen(function* () {
      const { id } = yield* payable
      const draft = yield* create(id, 2_500_000n)
      const access = { bankCode: "044", accountNumber: "1111111111" } as const

      yield* save(id, { mode: "manual", destination: access })

      const { payout } = yield* confirm(id, draft.id)

      assert.deepEqual(payout.destination, toGtbank)
      assert.equal((yield* postingOf(payout.id)).description, "Payout to GTBank ••••6789")

      const later = yield* create(id, 2_500_000n)

      assert.deepEqual([later.destination.bankCode, later.destination.accountNumber], ["044", "1111111111"])
    }),
  ))

// For providers stood in by hand: the dispatcher never reads callbacks.
const noCallbacks = { callback: () => Effect.die(new Error("the dispatcher reads no callbacks")) }

const dispatch = (provider: Layer.Layer<PayoutProvider.Service>) =>
  Effect.gen(function* () {
    const dispatcher = yield* PayoutDispatcher.Service

    yield* dispatcher.dispatch
  }).pipe(Effect.provide(PayoutDispatcher.layer.pipe(Layer.provide(provider))))

const report = (id: Payouts.ID, outcome: Payouts.Outcome) =>
  Effect.gen(function* () {
    const service = yield* Payouts.Service

    return yield* service.report(id, outcome, null)
  })

// Creates a payout and relays its hold so its status is `held`.
const heldPayout = (destination: Payouts.Change["destination"] = gtbank) =>
  Effect.gen(function* () {
    const { id } = yield* createBusiness()

    yield* save(id, { mode: "manual", destination })

    const { payout } = yield* request(id, 2_500_000n)

    assert.equal(yield* relayed(payout.id, fakeLedger(held)), "posted")

    return { businessId: id, payout: yield* get(id, payout.id) }
  })

// Creates a held payout and dispatches it so its status is `sent`.
const sentPayout = Effect.gen(function* () {
  const held = yield* heldPayout()

  yield* dispatch(ScriptedProvider.scripted().layer)

  return held
})

// Backdates `sent_at` by `minutes`, with the first check still due from the send.
const sentAgo = (id: string, minutes: number) =>
  Effect.gen(function* () {
    const database = yield* Database

    yield* database.use((db) =>
      db
        .update(payoutRows)
        .set({
          sentAt: sql`now() - make_interval(secs => ${minutes * 60})`,
          nextCheckAt: sql`now() - make_interval(secs => ${minutes * 60}) + make_interval(secs => ${Duration.toSeconds(PayoutDispatcher.firstCheck)})`,
        })
        .where(eq(payoutRows.id, id)),
    )
  })

// Backdates `sent_at` past the first check.
const lapse = (id: string) => sentAgo(id, 3)

// As if its checks had failed for `minutes` without an answer.
const failingFor = (id: string, minutes: number) =>
  Effect.gen(function* () {
    const database = yield* Database

    yield* database.use((db) =>
      db
        .update(payoutRows)
        .set({ checkFailingSince: sql`now() - make_interval(mins => ${minutes})` })
        .where(eq(payoutRows.id, id)),
    )
  })

void test("the dispatcher sends each held payout to the provider once, and marks it sent with the provider's reference", () =>
  run(
    Effect.gen(function* () {
      const { businessId, payout } = yield* heldPayout()
      const provider = ScriptedProvider.scripted()

      yield* dispatch(provider.layer)
      yield* dispatch(provider.layer)

      const sends = provider.sends.filter((transfer) => transfer.payoutId === payout.id)

      assert.equal(sends.length, 1)
      assert.deepEqual(
        [sends[0]?.amount, sends[0]?.ledger, sends[0]?.currencyCode, sends[0]?.destination, sends[0]?.providerRef],
        [2_500_000n, ngn, "NGN", toGtbank, null],
      )

      const shown = yield* get(businessId, payout.id)

      assert.deepEqual([shown.status, shown.providerRef, shown.completedAt], ["sent", `prov_${payout.id}`, null])
      assert.ok(shown.sentAt !== null)

      // Its hold is untouched: nothing is decided until the provider reports.
      const posting = yield* postingOf(payout.id)

      assert.deepEqual([posting.state, posting.resolution], ["pending", null])
    }),
  ))

void test("a paid report captures the hold: the payout is paid at once, and the relay sends the capture, replaying on retry", () =>
  run(
    Effect.gen(function* () {
      const { businessId, payout } = yield* sentPayout
      const before = nudges

      assert.ok(yield* report(payout.id, "paid"))
      assert.equal(nudges, before + 1, "the relay is nudged")

      const paid = yield* get(businessId, payout.id)

      assert.equal(paid.status, "paid")
      assert.ok(paid.completedAt !== null)

      const decided = yield* postingOf(payout.id)

      assert.deepEqual([decided.state, decided.resolution, decided.resolutionRef], ["pending", "capture", null])

      // The decided hold is due: the next claim takes it.
      const claimed = yield* Effect.gen(function* () {
        const postings = yield* LedgerPostings.Service

        return yield* postings.claim(1000)
      }).pipe(Effect.provide(fakeLedger(held).layer))

      assert.deepEqual(
        claimed.postings.filter((posting) => posting.id === decided.id).map((posting) => [posting.state, posting.resolution, posting.journalRef]),
        [["pending", "capture", "jrn_hold"]],
      )

      // A repeat changes nothing, nor does a contradiction.
      assert.equal(yield* report(payout.id, "paid"), false)
      assert.equal(yield* report(payout.id, "failed"), false)
      assert.equal((yield* get(businessId, payout.id)).status, "paid")

      // Down once, then it captures.
      const replies: Array<Reply> = ["unreachable"]
      const ledger = fakeLedger(held, (resolution) => replies.shift() ?? resolvedAs(resolution))

      assert.equal(yield* relayed(payout.id, ledger), "retrying")
      assert.equal(yield* relayed(payout.id, ledger), "posted")

      assert.deepEqual(ledger.sent, [], "the hold is not sent again")
      assert.deepEqual(ledger.resolutions.map(({ journalRef, key, payload }) => [journalRef, key, payload]), [
        ["jrn_hold", `${decided.id}:capture`, { ledger: "ngn_ng", action: "capture" }],
        ["jrn_hold", `${decided.id}:capture`, { ledger: "ngn_ng", action: "capture" }],
      ])

      const captured = yield* postingOf(payout.id)

      assert.deepEqual([captured.state, captured.journalRef, captured.resolutionRef], ["posted", "jrn_hold", "jrn_capture"])
      assert.equal((yield* get(businessId, payout.id)).status, "paid")

    }),
  ))

void test("a failed report voids the hold, and the payout is failed", () =>
  run(
    Effect.gen(function* () {
      const { businessId, payout } = yield* sentPayout

      assert.ok(yield* report(payout.id, "failed"))

      const failed = yield* get(businessId, payout.id)

      assert.equal(failed.status, "failed")
      assert.ok(failed.completedAt !== null)

      const ledger = fakeLedger(held)

      assert.equal(yield* relayed(payout.id, ledger), "voided")
      assert.deepEqual(ledger.resolutions.map(({ key, payload }) => [key, payload.action]), [
        [`${(yield* postingOf(payout.id)).id}:void`, "void"],
      ])

      const voided = yield* postingOf(payout.id)

      assert.deepEqual([voided.state, voided.resolution, voided.resolutionRef], ["voided", "void", "jrn_void"])
    }),
  ))

void test("only a sent payout takes a report", () =>
  run(
    Effect.gen(function* () {
      const { businessId, payout } = yield* heldPayout()
      const before = nudges

      assert.equal(yield* report(payout.id, "paid"), false)
      assert.equal(yield* report(Payouts.ID.make(`pout_${ulid()}`), "paid"), false)
      assert.equal(nudges, before)
      assert.equal((yield* get(businessId, payout.id)).status, "held")
      assert.equal((yield* postingOf(payout.id)).resolution, null)
    }),
  ))

void test("entry_resolved takes the ledger's state and resolution, even against what plane asked", () =>
  run(
    Effect.gen(function* () {
      const settledElsewhere = (state: string) => () => ({
        status: 409,
        body: {
          message: "Entry is already resolved.",
          error: { code: "entry_resolved" },
          pending_state: state,
          resolved_by: `jrn_${state}_elsewhere`,
        },
      })

      const agreeing = yield* sentPayout

      yield* report(agreeing.payout.id, "paid")

      assert.equal(yield* relayed(agreeing.payout.id, fakeLedger(held, settledElsewhere("captured"))), "posted")

      const captured = yield* postingOf(agreeing.payout.id)

      assert.deepEqual([captured.state, captured.resolutionRef], ["posted", "jrn_captured_elsewhere"])

      const contrary = yield* sentPayout

      yield* report(contrary.payout.id, "paid")

      assert.equal(yield* relayed(contrary.payout.id, fakeLedger(held, settledElsewhere("voided"))), "voided")

      const voided = yield* postingOf(contrary.payout.id)

      // The ledger is the truth; the payout keeps what the provider reported.
      assert.deepEqual([voided.state, voided.resolution, voided.resolutionRef], ["voided", "capture", "jrn_voided_elsewhere"])
      const shown = yield* get(contrary.businessId, contrary.payout.id)

      assert.deepEqual([shown.status, shown.ledgerMismatch], ["paid", true])
      assert.equal((yield* get(agreeing.businessId, agreeing.payout.id)).ledgerMismatch, false)

      // The void handed a paid payout's money back: asking again could pay it twice.
      assert.deepEqual(
        yield* Effect.flip(request(contrary.businessId, 2_500_000n)),
        new Payouts.LedgerMismatchError({ businessId: contrary.businessId, ledger: ngn }),
      )
    }),
  ))

void test("a resolution the ledger refuses leaves the queue, keeping the hold for support", () =>
  run(
    Effect.gen(function* () {
      const { businessId, payout } = yield* sentPayout
      // Created before the mismatch, confirmed after it.
      const draft = yield* create(businessId, 1_000_000n)

      yield* report(payout.id, "failed")

      const missing = fakeLedger(held, () => ({
        status: 404,
        body: { message: "Entry not found.", error: { code: "entry_not_found" } },
      }))

      assert.equal(yield* relayed(payout.id, missing), "refused")

      const posting = yield* postingOf(payout.id)

      assert.deepEqual(
        [posting.state, posting.errorCode, posting.journalRef, posting.resolutionRef],
        ["refused", "entry_not_found", "jrn_hold", null],
      )

      // The money's fate stands, and the payout says its hold wasn't released.
      const shown = yield* get(businessId, payout.id)

      assert.deepEqual([shown.status, shown.journalRef, shown.ledgerMismatch], ["failed", "jrn_hold", true])

      // No other payout until support corrects the hold.
      const blocked = new Payouts.LedgerMismatchError({ businessId, ledger: ngn })

      assert.deepEqual(yield* Effect.flip(create(businessId, 2_500_000n)), blocked)
      assert.deepEqual(yield* Effect.flip(confirm(businessId, draft.id)), blocked)
      // It can't be confirmed in time, so it gives up its slot.
      assert.equal((yield* get(businessId, draft.id)).status, "cancelled")
    }),
  ))

void test("a resolution answered for another hold or ledger leaves the queue, and the payout reads as mismatched", () =>
  run(
    Effect.gen(function* () {
      const { businessId, payout } = yield* sentPayout

      yield* report(payout.id, "paid")

      const elsewhere = fakeLedger(held, (resolution) => {
        const answer = resolvedAs(resolution)

        return answer === "unreachable" ? answer : { ...answer, body: { ...answer.body, pending_ref: "jrn_other" } }
      })

      assert.equal(yield* relayed(payout.id, elsewhere), "refused")

      const posting = yield* postingOf(payout.id)

      assert.deepEqual([posting.state, posting.errorCode, posting.resolution], ["refused", "unexpected_entry", "capture"])

      const shown = yield* get(businessId, payout.id)

      assert.deepEqual([shown.status, shown.ledgerMismatch], ["paid", true])
    }),
  ))

void test("past the first check, a payout the provider never paid is failed and its hold voided", () =>
  run(
    Effect.gen(function* () {
      const { businessId, payout } = yield* sentPayout
      const provider = ScriptedProvider.scripted("unpaid")
      const before = nudges

      yield* lapse(payout.id)
      yield* dispatch(provider.layer)

      assert.ok(provider.asked.includes(payout.id))
      assert.equal(nudges, before + 1)

      const failed = yield* get(businessId, payout.id)

      assert.equal(failed.status, "failed")
      assert.ok(failed.completedAt !== null)
      assert.equal((yield* postingOf(payout.id)).resolution, "void")
      assert.equal(yield* relayed(payout.id, fakeLedger(held)), "voided")
    }),
  ))

// The payout's status, and its hold's state and resolution.
const standing = (businessId: Business.ID, id: Payouts.ID) =>
  Effect.gen(function* () {
    const posting = yield* postingOf(id)

    return [(yield* get(businessId, id)).status, posting.state, posting.resolution] as const
  })

const flaggedWithHold = ["attention", "pending", null] as const

void test("a check answering paid under another ref than the stored one leaves the payout to a person, its hold kept", () =>
  run(
    Effect.gen(function* () {
      const { businessId, payout } = yield* sentPayout

      yield* lapse(payout.id)
      yield* dispatch(Layer.succeed(PayoutProvider.Service, PayoutProvider.Service.of({
        ...noCallbacks,
        send: (transfer) => Effect.succeed(ScriptedProvider.refOf(transfer.payoutId)),
        standing: () => Effect.succeed({ status: "paid", providerRef: PayoutProvider.ProviderRef.make("spo_other") } as const),
      })))

      assert.deepEqual(yield* standing(businessId, payout.id), flaggedWithHold)
      assert.equal((yield* get(businessId, payout.id)).providerRef, ScriptedProvider.refOf(payout.id))
    }),
  ))

void test("a report under another ref than the stored one, as from a callback, leaves the payout to a person; one under the stored ref settles", () =>
  run(
    Effect.gen(function* () {
      const service = yield* Payouts.Service
      const other = yield* sentPayout
      const matching = yield* sentPayout

      assert.equal(yield* service.report(other.payout.id, "paid", PayoutProvider.ProviderRef.make("spo_other")), false)
      assert.deepEqual(yield* standing(other.businessId, other.payout.id), flaggedWithHold)

      assert.equal(yield* service.report(matching.payout.id, "paid", ScriptedProvider.refOf(matching.payout.id)), true)
      assert.deepEqual(yield* standing(matching.businessId, matching.payout.id), ["paid", "pending", "capture"])
    }),
  ))

void test("a send accepted under another ref than the one already stored leaves the payout to a person, keeping the stored ref", () =>
  run(
    Effect.gen(function* () {
      const { businessId, payout } = yield* heldPayout()
      const database = yield* Database

      // Another ref lands while this send is out, then the provider accepts it as a new one.
      yield* dispatch(Layer.succeed(PayoutProvider.Service, PayoutProvider.Service.of({
        ...noCallbacks,
        send: (transfer) =>
          database
            .use((db) => db.update(payoutRows).set({ providerRef: "spo_first" }).where(eq(payoutRows.id, transfer.payoutId)))
            .pipe(Effect.as(PayoutProvider.ProviderRef.make("spo_other"))),
        standing: () => Effect.succeed({ status: "pending" } as const),
      })))

      assert.deepEqual(yield* standing(businessId, payout.id), flaggedWithHold)
      assert.equal((yield* get(businessId, payout.id)).providerRef, "spo_first")
    }),
  ))

void test("a send accepted under another ref after a callback settled the payout still logs both refs", () =>
  run(
    Effect.gen(function* () {
      const { businessId, payout } = yield* heldPayout()
      const service = yield* Payouts.Service
      const warnings: Array<unknown> = []

      // The callback settles the payout while this send is out.
      yield* dispatch(Layer.succeed(PayoutProvider.Service, PayoutProvider.Service.of({
        ...noCallbacks,
        send: (transfer) => service.report(transfer.payoutId, "paid", PayoutProvider.ProviderRef.make("spo_first")).pipe(Effect.as(PayoutProvider.ProviderRef.make("spo_other"))),
        standing: () => Effect.succeed({ status: "pending" } as const),
      }))).pipe(
        Effect.provide(Logger.layer([Logger.make(({ logLevel, message, fiber }) => {
          if (logLevel === "Warn") {
            warnings.push([message, fiber.getRef(References.CurrentLogAnnotations)])
          }
        })])),
      )

      assert.equal((yield* get(businessId, payout.id)).status, "paid")
      assert.deepEqual(warnings, [[
        ["payout accepted under another provider ref than the stored one"],
        { payoutId: payout.id, storedRef: "spo_first", acceptedRef: "spo_other" },
      ]])
    }),
  ))

void test("a pending answer without a ref is taken, and the payout is checked again on schedule", () =>
  run(
    Effect.gen(function* () {
      const { payout } = yield* sentPayout
      const sim = simAnswering(201, (reference) => Response.json({ reference, status: "pending" }))

      yield* lapse(payout.id)
      yield* dispatch(sim.layer)

      assert.deepEqual(yield* schedule(payout.id), ["sent", null, 4])
    }),
  ))

void test("the database refuses a paid payout with a blank ref", () =>
  run(
    Effect.gen(function* () {
      const { payout } = yield* sentPayout
      const database = yield* Database

      const exit = yield* Effect.exit(database.use((db) =>
        db.update(payoutRows).set({ status: "paid", completedAt: sql`now()`, providerRef: " " }).where(eq(payoutRows.id, payout.id))))

      const cause = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
      const error = cause instanceof Error && cause.cause instanceof Error ? cause.cause : undefined

      assert.equal(error !== undefined && "constraint" in error ? error.constraint : undefined, "payouts_paid_has_ref")
    }),
  ))

void test("past the first check, a payout the provider says it paid is paid and its hold captured", () =>
  run(
    Effect.gen(function* () {
      const { businessId, payout } = yield* sentPayout

      yield* lapse(payout.id)
      yield* dispatch(ScriptedProvider.scripted("paid").layer)

      const paid = yield* get(businessId, payout.id)

      assert.equal(paid.status, "paid")
      assert.ok(paid.completedAt !== null)
      assert.equal((yield* postingOf(payout.id)).resolution, "capture")
      assert.equal(yield* relayed(payout.id, fakeLedger(held)), "posted")
    }),
  ))

void test("past the first check, a payout the provider can't speak for needs attention and its hold stays", () =>
  run(
    Effect.gen(function* () {
      // Its "can't say" at once; no answer at all, once checks have failed for an hour.
      for (const [standing, failing] of [["unknown", null], [null, 61]] as const) {
        const { businessId, payout } = yield* sentPayout

        yield* lapse(payout.id)

        if (failing !== null) {
          yield* failingFor(payout.id, failing)
        }

        yield* dispatch(ScriptedProvider.scripted(standing).layer)

        const shown = yield* get(businessId, payout.id)

        assert.deepEqual([shown.status, shown.completedAt], ["attention", null], String(standing))

        const posting = yield* postingOf(payout.id)

        assert.deepEqual([posting.state, posting.resolution], ["pending", null], String(standing))

        // A late report is support's to weigh.
        assert.equal(yield* report(payout.id, "paid"), false)
      }
    }),
  ))

void test("a draft that no longer meets its currency's rules isn't confirmed, and is cancelled", () =>
  run(
    Effect.gen(function* () {
      const { id } = yield* payable
      const draft = yield* create(id, 2_500_000n)
      const database = yield* Database

      // As if the minimum rose after it was created.
      yield* database.use((db) => db.update(payoutRows).set({ amount: 100n }).where(eq(payoutRows.id, draft.id)))

      assert.deepEqual(yield* Effect.flip(confirm(id, draft.id)), new Payouts.RulesChangedError({ id: draft.id }))
      assert.equal((yield* get(id, draft.id)).status, "cancelled")
    }),
  ))

void test("past the first check, a provider that doesn't answer is asked again, not flagged", () =>
  run(
    Effect.gen(function* () {
      const { businessId, payout } = yield* sentPayout
      const provider = ScriptedProvider.scripted(null)

      yield* lapse(payout.id)
      yield* dispatch(provider.layer)

      assert.deepEqual([(yield* get(businessId, payout.id)).status, provider.asked.length], ["sent", 1])
    }),
  ))

void test("a payout that can't be settled at the first check stays sent for the next pass, and those behind it are still settled", () =>
  run(
    Effect.gen(function* () {
      const broken = yield* sentPayout
      const behind = yield* sentPayout

      // Settling the oldest dies, as a broken invariant would.
      const dying = Layer.succeed(PayoutProvider.Service, PayoutProvider.Service.of({
        ...noCallbacks,
        send: (transfer) => Effect.succeed(ScriptedProvider.refOf(transfer.payoutId)),
        standing: (transfer) =>
          transfer.payoutId === broken.payout.id
            ? Effect.die(new Error("broken"))
            : Effect.succeed({ status: "unpaid", providerRef: ScriptedProvider.refOf(transfer.payoutId) } as const),
      }))

      yield* sentAgo(broken.payout.id, 4)
      yield* lapse(behind.payout.id)
      yield* dispatch(dying)

      assert.equal((yield* get(broken.businessId, broken.payout.id)).status, "sent")
      assert.equal((yield* get(behind.businessId, behind.payout.id)).status, "failed")
    }),
  ))

void test("a payout whose settling keeps dying is checked again only after a minute, and goes to attention an hour past the first check", () =>
  run(
    Effect.gen(function* () {
      const { businessId, payout } = yield* sentPayout
      const asked: Array<string> = []

      const dying = Layer.succeed(PayoutProvider.Service, PayoutProvider.Service.of({
        ...noCallbacks,
        send: (transfer) => Effect.succeed(ScriptedProvider.refOf(transfer.payoutId)),
        standing: (transfer) => Effect.sync(() => asked.push(transfer.payoutId)).pipe(Effect.andThen(Effect.die(new Error("broken")))),
      }))

      const checkedAgo = (minutes: number) =>
        Effect.gen(function* () {
          const database = yield* Database

          yield* database.use((db) =>
            db
              .update(payoutRows)
              .set({ settleAttemptedAt: sql`now() - make_interval(mins => ${minutes})` })
              .where(eq(payoutRows.id, payout.id)),
          )
        })

      yield* lapse(payout.id)
      yield* dispatch(dying)
      // Not again within the minute, so it can't crowd out the rest.
      yield* dispatch(dying)

      assert.deepEqual([(yield* get(businessId, payout.id)).status, asked.length], ["sent", 1])

      yield* checkedAgo(2)
      yield* dispatch(dying)

      assert.deepEqual([(yield* get(businessId, payout.id)).status, asked.length], ["sent", 2])

      yield* failingFor(payout.id, 61)
      yield* checkedAgo(2)
      yield* dispatch(dying)

      assert.deepEqual([(yield* get(businessId, payout.id)).status, asked.length], ["attention", 3])
    }),
  ))

// Backdates payout dispatch timestamps by `minutes` to simulate elapsed time.
const passed = (id: string, minutes: number) =>
  Effect.gen(function* () {
    const database = yield* Database
    const back = sql`make_interval(mins => ${minutes})`

    yield* database.use((db) =>
      db
        .update(payoutRows)
        .set({
          sentAt: sql`${payoutRows.sentAt} - ${back}`,
          settleAttemptedAt: sql`${payoutRows.settleAttemptedAt} - ${back}`,
          nextCheckAt: sql`${payoutRows.nextCheckAt} - ${back}`,
          checkFailingSince: sql`${payoutRows.checkFailingSince} - ${back}`,
        })
        .where(eq(payoutRows.id, id)),
    )
  })

void test("a check that fails after a long pending wait is checked again, not left to a person", () =>
  run(
    Effect.gen(function* () {
      const { businessId, payout } = yield* sentPayout

      // Pending at each scheduled check: T+2m, 4m, 9m, 19m, 49m, and 109m.
      for (const minutes of [2, 2, 5, 10, 30, 60]) {
        const pending = ScriptedProvider.scripted("pending")

        yield* passed(payout.id, minutes)
        yield* dispatch(pending.layer)

        assert.deepEqual([(yield* get(businessId, payout.id)).status, pending.asked.length], ["sent", 1], String(minutes))
      }

      // The T+169m check fails once.
      const down = ScriptedProvider.scripted(null)

      yield* passed(payout.id, 60)
      yield* dispatch(down.layer)

      assert.deepEqual([(yield* get(businessId, payout.id)).status, down.asked.length], ["sent", 1])
      assert.equal((yield* postingOf(payout.id)).resolution, null)

      // Retried a minute later, it settles on the provider's response.
      const answered = ScriptedProvider.scripted("paid")

      yield* passed(payout.id, 1)
      yield* dispatch(answered.layer)

      assert.deepEqual([(yield* get(businessId, payout.id)).status, answered.asked.length], ["paid", 1])
      assert.equal((yield* postingOf(payout.id)).resolution, "capture")
    }),
  ))

void test("checks failing for an hour leave the payout to a person, its hold kept", () =>
  run(
    Effect.gen(function* () {
      const { businessId, payout } = yield* sentPayout
      const down = ScriptedProvider.scripted(null)

      // Pending at T+2m; next check scheduled for T+4m.
      yield* passed(payout.id, 2)
      yield* dispatch(ScriptedProvider.scripted("pending").layer)

      // Checks fail starting at T+4m, still within the 1-hour failure window at T+62m.
      yield* passed(payout.id, 2)
      yield* dispatch(down.layer)
      yield* passed(payout.id, 58)
      yield* dispatch(down.layer)

      assert.deepEqual([(yield* get(businessId, payout.id)).status, down.asked.length], ["sent", 2])

      // At T+64m, an hour after the first failure, the payout is flagged for attention.
      yield* passed(payout.id, 2)
      yield* dispatch(down.layer)

      assert.deepEqual([(yield* get(businessId, payout.id)).status, down.asked.length], ["attention", 3])

      const posting = yield* postingOf(payout.id)

      assert.deepEqual([posting.state, posting.resolution], ["pending", null])
    }),
  ))

void test("one failed check on a payout due long ago, as after plane was down, is retried, and an answer clears the failure", () =>
  run(
    Effect.gen(function* () {
      const { businessId, payout } = yield* sentPayout
      const database = yield* Database

      const failingSince = () =>
        Effect.map(
          database.use((db) =>
            db.select({ since: payoutRows.checkFailingSince }).from(payoutRows).where(eq(payoutRows.id, payout.id)),
          ),
          (rows) => rows[0]?.since ?? null,
        )

      // Its first check was due 68 minutes ago, and fails.
      yield* sentAgo(payout.id, 70)
      yield* dispatch(ScriptedProvider.scripted(null).layer)

      assert.equal((yield* get(businessId, payout.id)).status, "sent")
      assert.ok((yield* failingSince()) !== null)

      // Retried a minute later; pending is an answer.
      const pending = ScriptedProvider.scripted("pending")

      yield* passed(payout.id, 1)
      yield* dispatch(pending.layer)

      assert.deepEqual([(yield* get(businessId, payout.id)).status, pending.asked.length], ["sent", 1])
      assert.equal(yield* failingSince(), null)
    }),
  ))

void test("a send the provider never answered isn't sent again until a check finds it not received", () =>
  run(
    Effect.gen(function* () {
      const { businessId, payout } = yield* heldPayout()
      const provider = ScriptedProvider.scripted("not_received", 1)
      const sendsOf = () => provider.sends.filter((transfer) => transfer.payoutId === payout.id).length

      yield* dispatch(provider.layer)
      yield* dispatch(provider.layer)

      const unanswered = yield* get(businessId, payout.id)

      assert.deepEqual([unanswered.status, unanswered.providerRef, sendsOf()], ["sent", null, 1])

      // The first check: never received, so it is sent again, under the same reference.
      yield* lapse(payout.id)
      yield* dispatch(provider.layer)

      const resent = yield* get(businessId, payout.id)

      assert.deepEqual([resent.status, resent.providerRef, sendsOf()], ["sent", `prov_${payout.id}`, 2])
      assert.equal((yield* postingOf(payout.id)).resolution, null)
    }),
  ))

// The payout's status, its hold's resolution, and its next check in minutes after the send.
const schedule = (id: string) =>
  Effect.gen(function* () {
    const database = yield* Database

    const result = yield* database.use((db) =>
      db.execute<{ status: string; resolution: string | null; next_check: number | null }>(sql`
        select p.status, l.resolution, round(extract(epoch from p.next_check_at - p.sent_at) / 60)::int as next_check
        from payouts p join ledger_postings l on l.payout_id = p.id
        where p.id = ${id}
      `),
    )

    const row = result.rows[0] ?? assert.fail(`no payout ${id}`)

    return [row.status, row.resolution, row.next_check] as const
  })

void test("a provider still processing is asked again only on the schedule, and a payout pending at the give-up is left to a person", () =>
  run(
    Effect.gen(function* () {
      const { payout } = yield* heldPayout()
      const provider = ScriptedProvider.scripted("pending")

      yield* dispatch(provider.layer)
      assert.deepEqual(yield* schedule(payout.id), ["sent", null, 2])

      // Pending at the first check, so asked again at four minutes.
      yield* passed(payout.id, 2)
      yield* dispatch(provider.layer)
      assert.deepEqual(yield* schedule(payout.id), ["sent", null, 4])

      // Not before then, however often the dispatcher passes.
      const checks = provider.asked.length

      yield* passed(payout.id, 1)
      yield* dispatch(provider.layer)
      assert.equal(provider.asked.length, checks)

      yield* passed(payout.id, 1)
      yield* dispatch(provider.layer)
      assert.deepEqual(yield* schedule(payout.id), ["sent", null, 9])

      // Still pending a day on: a person takes it, and the hold stays.
      yield* passed(payout.id, 24 * 60)
      yield* dispatch(provider.layer)
      assert.deepEqual(yield* schedule(payout.id), ["attention", null, 9])
    }),
  ))

void test("a payout pending at earlier checks is settled by the scheduled check that finds it final: failed voids its hold, paid captures it", () =>
  run(
    Effect.gen(function* () {
      for (const [final, settled] of [["unpaid", ["failed", "void", 9]], ["paid", ["paid", "capture", 9]]] as const) {
        const { payout } = yield* heldPayout()
        const provider = ScriptedProvider.scripted("pending")

        // Pending at two minutes and at four.
        yield* dispatch(provider.layer)
        yield* passed(payout.id, 2)
        yield* dispatch(provider.layer)
        yield* passed(payout.id, 2)
        yield* dispatch(provider.layer)
        assert.deepEqual(yield* schedule(payout.id), ["sent", null, 9], final)

        provider.script.standing = final
        yield* passed(payout.id, 5)
        yield* dispatch(provider.layer)
        assert.deepEqual(yield* schedule(payout.id), settled, final)
      }
    }),
  ))

void test("a send whose reply was lost is paid on the check, with the provider's ref", () =>
  run(
    Effect.gen(function* () {
      const { businessId, payout } = yield* heldPayout()
      const provider = ScriptedProvider.scripted("paid", 1)

      yield* dispatch(provider.layer)
      assert.equal((yield* get(businessId, payout.id)).providerRef, null)

      yield* lapse(payout.id)
      yield* dispatch(provider.layer)

      assert.deepEqual(yield* schedule(payout.id), ["paid", "capture", 2])
      assert.deepEqual([(yield* get(businessId, payout.id)).providerRef, provider.sends.length], [ScriptedProvider.refOf(payout.id), 1])
    }),
  ))

void test("a payout the provider acknowledged with a ref, then can't find, is left to a person with its hold kept, never sent again or voided", () =>
  run(
    Effect.gen(function* () {
      for (const reached of ["the first check", "the give-up"] as const) {
        const { businessId, payout } = yield* heldPayout()
        const provider = ScriptedProvider.scripted(reached === "the first check" ? "not_received" : "pending")

        yield* dispatch(provider.layer)
        assert.equal((yield* get(businessId, payout.id)).providerRef, ScriptedProvider.refOf(payout.id))

        yield* lapse(payout.id)
        yield* dispatch(provider.layer)

        if (reached === "the give-up") {
          // Pending until a day has passed, then lost: the give-up must not void it.
          provider.script.standing = "not_received"
          yield* passed(payout.id, 24 * 60)
          yield* dispatch(provider.layer)
        }

        const posting = yield* postingOf(payout.id)

        assert.deepEqual([(yield* get(businessId, payout.id)).status, provider.sends.length], ["attention", 1], reached)
        assert.deepEqual([posting.state, posting.resolution], ["pending", null], reached)
      }
    }),
  ))

void test("a provider down at the send and the first checks is sent again once a check finds the payout not received, then paid", () =>
  run(
    Effect.gen(function* () {
      const { businessId, payout } = yield* heldPayout()
      const provider = ScriptedProvider.scripted(null, 1)

      // The send and the first two checks fail.
      yield* dispatch(provider.layer)
      yield* passed(payout.id, 2)
      yield* dispatch(provider.layer)
      yield* passed(payout.id, 1)
      yield* dispatch(provider.layer)

      assert.equal(provider.sends.length, 1)
      assert.deepEqual(yield* schedule(payout.id), ["sent", null, 2])

      // Back up: the retried check finds it not received, so it is sent again.
      provider.script.standing = "not_received"
      yield* passed(payout.id, 1)
      yield* dispatch(provider.layer)

      assert.deepEqual([provider.sends.length, (yield* get(businessId, payout.id)).providerRef], [2, ScriptedProvider.refOf(payout.id)])

      provider.script.standing = "paid"
      yield* passed(payout.id, 10)
      yield* dispatch(provider.layer)

      assert.deepEqual(yield* schedule(payout.id), ["paid", "capture", 9])
    }),
  ))

void test("a payout the provider still hasn't received at the give-up is failed and its hold voided", () =>
  run(
    Effect.gen(function* () {
      const { businessId, payout } = yield* heldPayout()
      const provider = ScriptedProvider.scripted("not_received", Number.MAX_SAFE_INTEGER)

      yield* dispatch(provider.layer)

      // Never received at the first check: sent again, which fails too.
      yield* passed(payout.id, 3)
      yield* dispatch(provider.layer)
      assert.deepEqual([...(yield* schedule(payout.id)), provider.sends.length], ["sent", null, 4, 2])

      yield* passed(payout.id, 24 * 60)
      yield* dispatch(provider.layer)

      assert.deepEqual(yield* schedule(payout.id), ["failed", "void", 4])
      assert.equal((yield* get(businessId, payout.id)).providerRef, null)
    }),
  ))

// The sim adapter over a stub that answers each send with `sendStatus` and
// each lookup with `lookup` (the sim's not-found error unless given), counting the sends.
const simAnswering = (
  sendStatus: number,
  lookup: (reference: string) => Response = () => Response.json({ error: { code: "not_found" } }, { status: 404 }),
) => {
  const sends = { count: 0 }

  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      sends.count += request.method === "POST" ? 1 : 0

      return HttpClientResponse.fromWeb(
        request,
        request.method === "POST"
          ? Response.json({ error: { code: "invalid_payout" } }, { status: sendStatus })
          : lookup(decodeURIComponent(new URL(request.url).pathname.split("/").at(-1) ?? "")),
      )
    }))

  const layer = SimProvider.layer.pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ SIM_URL: "http://sim.test", SIM_API_KEY: "key", SIM_WEBHOOK_SECRET: "secret" }))),
    Layer.orDie,
  )

  return { sends, layer }
}

void test("a send the sim refuses with a 400 leaves the payout to a person with its hold kept, and it isn't sent again", () =>
  run(
    Effect.gen(function* () {
      const { businessId, payout } = yield* heldPayout()
      const sim = simAnswering(400)

      yield* dispatch(sim.layer)
      yield* lapse(payout.id)
      yield* dispatch(sim.layer)

      const posting = yield* postingOf(payout.id)

      assert.deepEqual([(yield* get(businessId, payout.id)).status, sim.sends.count], ["attention", 1])
      assert.deepEqual([posting.state, posting.resolution], ["pending", null])
    }),
  ))

void test("a send answered 401, as with a bad API key, is retried: the payout stays sent and is sent again once a check finds it not received", () =>
  run(
    Effect.gen(function* () {
      const { businessId, payout } = yield* heldPayout()
      const sim = simAnswering(401)

      yield* dispatch(sim.layer)
      yield* lapse(payout.id)
      yield* dispatch(sim.layer)

      assert.deepEqual([(yield* get(businessId, payout.id)).status, sim.sends.count], ["sent", 2])
      assert.equal((yield* postingOf(payout.id)).resolution, null)
    }),
  ))

void test("a provider that refuses a send, such as one holding the reference with other details, leaves the payout to a person, its hold kept", () =>
  run(
    Effect.gen(function* () {
      const { businessId, payout } = yield* heldPayout()

      yield* dispatch(Layer.succeed(PayoutProvider.Service, PayoutProvider.Service.of({
        ...noCallbacks,
        send: () => Effect.fail(new PayoutProvider.RefusedError({ message: "reference reused" })),
        standing: () => Effect.succeed({ status: "pending" } as const),
      })))

      assert.equal((yield* get(businessId, payout.id)).status, "attention")
      assert.equal((yield* postingOf(payout.id)).resolution, null)
    }),
  ))

void test("a sent payout before its first check is left waiting, and the provider isn't asked", () =>
  run(
    Effect.gen(function* () {
      const { businessId, payout } = yield* sentPayout
      const provider = ScriptedProvider.scripted("unpaid")

      yield* dispatch(provider.layer)

      assert.ok(!provider.asked.includes(payout.id))
      assert.equal((yield* get(businessId, payout.id)).status, "sent")
    }),
  ))

void test("a hold the ledger never confirms leaves its payout to a person five minutes after the first try", () =>
  run(
    Effect.gen(function* () {
      const { id } = yield* createBusiness()
      const database = yield* Database

      yield* save(id, { mode: "manual", destination: gtbank })

      const age = (payoutId: string, column: "created_at" | "first_attempt_at", minutes: number) =>
        database.use((db) =>
          db.execute(
            sql`update ledger_postings set ${sql.identifier(column)} = now() - make_interval(mins => ${minutes}) where payout_id = ${payoutId}`,
          ),
        )

      const statuses = (...ids: ReadonlyArray<string>) =>
        Effect.forEach(ids, (payoutId) => Effect.map(get(id, payoutId), (payout) => payout.status))

      // Tried, and the ledger never answered.
      const tried = (yield* request(id, 2_500_000n)).payout
      assert.equal(yield* relayed(tried.id, fakeLedger(() => "unreachable")), "retrying")

      // Confirmed long ago, but first tried just now, as after an outage.
      const late = (yield* request(id, 2_500_000n)).payout
      yield* age(late.id, "created_at", 30)
      assert.equal(yield* relayed(late.id, fakeLedger(() => "unreachable")), "retrying")

      // Never tried yet, as after a restart.
      const untried = (yield* request(id, 2_500_000n)).payout
      yield* age(untried.id, "created_at", 30)

      yield* age(tried.id, "first_attempt_at", 4)
      yield* dispatch(ScriptedProvider.scripted().layer)

      assert.deepEqual(yield* statuses(tried.id, late.id, untried.id), ["requested", "requested", "requested"])

      yield* age(tried.id, "first_attempt_at", 6)
      yield* dispatch(ScriptedProvider.scripted().layer)

      assert.deepEqual(yield* statuses(tried.id, late.id, untried.id), ["attention", "requested", "requested"])

      // The ledger's later answer is still recorded. Held, it stays with a person.
      assert.equal(yield* relayed(tried.id, fakeLedger(held)), "posted")
      assert.equal((yield* get(id, tried.id)).status, "attention")

      // Refused, nothing was held, so it is rejected.
      yield* age(late.id, "first_attempt_at", 6)
      yield* dispatch(ScriptedProvider.scripted().layer)
      assert.equal((yield* get(id, late.id)).status, "attention")

      assert.equal(yield* relayed(late.id, fakeLedger(insufficient)), "refused")
      assert.equal((yield* get(id, late.id)).status, "rejected")
    }),
  ))

void test("the dispatcher expires created payouts past their lifetime and leaves the rest", () =>
  run(
    Effect.gen(function* () {
      const { id } = yield* payable
      const stale = yield* create(id, 10_000n)
      const fresh = yield* create(id, 10_000n)

      yield* Testing.createdAgo(stale.id, Duration.seconds(100))
      yield* dispatch(ScriptedProvider.scripted().layer)

      const expired = yield* get(id, stale.id)

      assert.equal(expired.status, "expired")
      assert.ok(expired.completedAt !== null)
      assert.equal((yield* get(id, fresh.id)).status, "created")
    }),
  ))
