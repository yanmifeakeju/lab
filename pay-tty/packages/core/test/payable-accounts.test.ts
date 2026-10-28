import assert from "node:assert/strict"
import { test } from "node:test"

import { Cause, ConfigProvider, DateTime, Effect, Exit, Layer, Schema } from "effect"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientError from "effect/unstable/http/HttpClientError"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"

import { LedgerClient } from "../src/ledger/client.ts"
import { PayableAccounts } from "../src/ledger/payable-accounts.ts"
import { Ledger } from "../src/ledger/slug.ts"

const accountRef = "acct_01K33YV8M82N9MXP4E7J6B1QWK"

const ledger = Ledger.Slug.make("ngn_ng")

interface Counters {
  readonly available: number | string
  readonly debits_pending: number | string
  readonly credits_pending: number | string
  readonly debits_posted: number | string
  readonly credits_posted: number | string
}

// Written out as JSON text, so a counter can be a literal JSON.parse rounds.
const account = (counters: Counters, overrides: { reference?: string; ledger_slug?: string; status?: string } = {}) => {
  const fields = {
    reference: accountRef,
    holder_reference: "hld_01K33YVADP5Z8B0T3X2Q91C6RH",
    ledger_slug: "ngn_ng",
    kind: "payable",
    name: "Acme Stores",
    status: "open",
    closed_at: null,
    created_at: "2026-09-08T10:30:00Z",
    ...overrides,
  }

  const json = JSON.stringify(fields).slice(0, -1)
  const { available, ...balances } = counters
  const pairs = Object.entries(balances).map(([key, value]) => `"${key}":${value}`).join(",")

  return { status: 200, raw: `${json},"available":${available},"balances":{${pairs}}}` }
}

const counters = (available: number | string, creditsPending: number | string = 0): Counters => ({
  available,
  debits_pending: 200,
  credits_pending: creditsPending,
  debits_posted: 0,
  credits_posted: 10_000,
})

type Reply = { readonly status: number; readonly raw: string } | "unreachable"

// The ledger service, faked at the HTTP boundary so the client and its
// decoding still run.
const ledgerAnswering = (reply: Reply) => {
  const urls: Array<URL> = []

  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      urls.push(new URL((yield* Effect.orDie(HttpClientRequest.toWeb(request))).url))

      if (reply === "unreachable") {
        return yield* new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, description: "connection refused" }),
        })
      }

      return HttpClientResponse.fromWeb(
        request,
        new Response(reply.raw, { status: reply.status, headers: { "content-type": "application/json" } }),
      )
    }),
  )

  const layer = PayableAccounts.layer.pipe(
    Layer.provide(LedgerClient.layer),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ LEDGER_BASE_URL: "http://ledger.test" }))),
    Layer.orDie,
  )

  return { urls, layer }
}

const balanceFrom = (reply: Reply) => {
  const { urls, layer } = ledgerAnswering(reply)

  const balance = Effect.gen(function* () {
    const accounts = yield* PayableAccounts.Service

    return yield* accounts.balance({ accountRef, ledger })
  }).pipe(Effect.provide(layer))

  return { urls, balance }
}

const failureOf = (reply: Reply) => Effect.flip(balanceFrom(reply).balance)

const run = <A, E>(effect: Effect.Effect<A, E>) => () => Effect.runPromise(effect)

void test("a balance is the account's available amount and its pending credits", run(
  Effect.gen(function* () {
    const { urls, balance } = balanceFrom(account(counters(9_800, 1_500)))

    assert.deepEqual(yield* balance, new PayableAccounts.Balance({ available: 9_800n, pending: 1_500n }))
    assert.deepEqual(urls.map((url) => url.pathname), [`/accounts/${accountRef}`])
  }),
))

void test("a closed account still reports its balance", run(
  Effect.gen(function* () {
    const { balance } = balanceFrom(account(counters(9_800), { status: "closed" }))

    assert.equal((yield* balance).available, 9_800n)
  }),
))

void test("an answer for another account or ledger is a bad response", run(
  Effect.gen(function* () {
    const cases = [["another account", { reference: "acct_01K33YV8M82N9MXP4E7J6B1QWZ" }], ["another ledger", {
      ledger_slug: "usd_us",
    }]] as const

    for (const [name, overrides] of cases) {
      assert.ok(Schema.is(PayableAccounts.BadResponseError)(yield* failureOf(account(counters(9_800), overrides))), name)
    }
  }),
))

void test("a ledger that can't be reached is unavailable", run(
  Effect.gen(function* () {
    assert.ok(Schema.is(PayableAccounts.UnavailableError)(yield* failureOf("unreachable")))
  }),
))

void test("an account the ledger doesn't have is a rejection", run(
  Effect.gen(function* () {
    const error = yield* failureOf({
      status: 404,
      raw: `{"message":"Account not found.","error":{"code":"account_not_found"}}`,
    })

    assert.deepEqual(error, new PayableAccounts.RejectedError({ reason: "account_not_found" }))
  }),
))

void test("a counter past 2^53−1 is a bad response, never a rounded figure", run(
  Effect.gen(function* () {
    for (const reply of [account(counters("9007199254740993")), account(counters(9_800, "9007199254740993"))]) {
      assert.ok(Schema.is(PayableAccounts.BadResponseError)(yield* failureOf(reply)))
    }
  }),
))

interface Figures {
  readonly opening: number | string
  readonly closing: number | string
  readonly amount: number | string
  readonly balanceAfter: number | string
}

// A statement page as JSON text, newest first: a credit and then, on two lines
// of one entry, a debit and a credit.
const statement = (
  figures: Figures = { opening: 0, closing: 7_500, amount: 2_500, balanceAfter: 7_500 },
  overrides: { reference?: string; recorded_at?: string; next?: string | null } = {},
) => {
  const movement = (
    fields: Readonly<Record<string, string | number>>,
    amount: number | string,
    balanceAfter: number | string,
  ) =>
    `${JSON.stringify({
      journal_reference: "jrn_01M20J1QD2XB8K7G4N9CVF6T3A",
      line_number: 1,
      kind: "payment",
      direction: "credit",
      description: "Payment received via Haircut deposit",
      purpose: "payment",
      recorded_at: overrides.recorded_at ?? "2026-10-09T09:15:00Z",
      ...fields,
    }).slice(0, -1)},"amount":${amount},"balance_after":${balanceAfter}}`

  const entries = [
    movement({}, figures.amount, figures.balanceAfter),
    movement({ journal_reference: "jrn_01M20J1QD2XB8K7G4N9CVF6T3B", line_number: 2, recorded_at: "2026-10-02T08:00:00Z" }, 5_000, 5_000),
    movement({
      journal_reference: "jrn_01M20J1QD2XB8K7G4N9CVF6T3B",
      direction: "debit",
      description: "Fee",
      purpose: "fee",
      recorded_at: "2026-10-02T08:00:00Z",
    }, 200, 0),
  ].join(",")

  const fields = JSON.stringify({
    account: { reference: overrides.reference ?? accountRef, holder_reference: "hld_01K33YVADP5Z8B0T3X2Q91C6RH", name: "Acme Stores" },
    period: { from: "2026-09-28T10:00:00Z", to: "2026-10-28T09:59:00Z" },
    page: { limit: 50, previous_cursor: null, next_cursor: overrides.next === undefined ? "older" : overrides.next },
  }).slice(0, -1)

  return {
    status: 200,
    raw: `${fields},"opening_balance":${figures.opening},"closing_balance":${figures.closing},"entries":[${entries}]}`,
  }
}

// Instants as core holds them.
const at = (iso: string) => DateTime.toDateUtc(DateTime.makeUnsafe(iso))

const firstPage: PayableAccounts.Window = { from: at("2026-09-28T10:00:00Z") }

const statementFrom = (reply: Reply, window: PayableAccounts.Window = firstPage) => {
  const { urls, layer } = ledgerAnswering(reply)

  const read = Effect.gen(function* () {
    const accounts = yield* PayableAccounts.Service

    return yield* accounts.statement({ accountRef, ledger }, window)
  }).pipe(Effect.provide(layer))

  return { urls, read }
}

void test("a statement keeps the ledger's order and cursors, with every figure a bigint", run(
  Effect.gen(function* () {
    const { urls, read } = statementFrom(statement())
    const page = yield* read

    assert.deepEqual(page.period, { from: at("2026-09-28T10:00:00Z"), to: at("2026-10-28T09:59:00Z") })
    assert.equal(page.opening, 0n)
    assert.equal(page.closing, 7_500n)
    assert.equal(page.previous, null)
    assert.equal(page.next, "older")
    assert.deepEqual(page.movements[0], new PayableAccounts.Movement({
      journalRef: "jrn_01M20J1QD2XB8K7G4N9CVF6T3A",
      lineNumber: 1,
      direction: "credit",
      amount: 2_500n,
      balanceAfter: 7_500n,
      description: "Payment received via Haircut deposit",
      purpose: "payment",
      recordedAt: at("2026-10-09T09:15:00Z"),
    }))
    assert.deepEqual(
      page.movements.map(({ journalRef, lineNumber, direction }) => `${journalRef.slice(-1)}${lineNumber}${direction}`),
      ["A1credit", "B2credit", "B1debit"],
    )
    assert.deepEqual(urls.map((url) => url.pathname), [`/accounts/${accountRef}/statement`])
  }),
))

void test("a statement always asks for newest first, from the period's start or the cursor alone", run(
  Effect.gen(function* () {
    const cases: ReadonlyArray<readonly [PayableAccounts.Window, Readonly<Record<string, string>>]> = [
      [{ from: at("2026-10-21T10:00:00Z") }, { order: "desc", from: "2026-10-21T10:00:00.000Z" }],
      [{ cursor: "abc" }, { order: "desc", cursor: "abc" }],
    ]

    for (const [window, query] of cases) {
      const { urls, read } = statementFrom(statement(), window)

      yield* read

      assert.deepEqual(Object.fromEntries(urls[0]?.searchParams ?? []), query)
    }
  }),
))

void test("a statement for another account, or with figures past 2^53−1 or no times, is a bad response", run(
  Effect.gen(function* () {
    const unsafe = "9007199254740993"

    const replies = [
      statement(undefined, { reference: "acct_01K33YV8M82N9MXP4E7J6B1QWZ" }),
      statement(undefined, { recorded_at: "yesterday" }),
      statement({ opening: unsafe, closing: 0, amount: 1, balanceAfter: 1 }),
      statement({ opening: 0, closing: unsafe, amount: 1, balanceAfter: 1 }),
      statement({ opening: 0, closing: 0, amount: unsafe, balanceAfter: 1 }),
      statement({ opening: 0, closing: 0, amount: 1, balanceAfter: unsafe }),
    ]

    for (const reply of replies) {
      assert.ok(Schema.is(PayableAccounts.BadResponseError)(yield* Effect.flip(statementFrom(reply).read)), reply.raw)
    }
  }),
))

void test("a statement the ledger can't serve is unavailable or rejected, and a refused cursor the caller's", run(
  Effect.gen(function* () {
    const refused = (field: string): Reply => ({
      status: 400,
      raw: JSON.stringify({
        message: "Request validation failed.",
        error: {
          code: "validation_error",
          details: [{ location: "query", field, code: "invalid_value", message: `${field} is invalid` }],
        },
      }),
    })

    const failure = (reply: Reply, window: PayableAccounts.Window = firstPage) => Effect.flip(statementFrom(reply, window).read)

    assert.ok(Schema.is(PayableAccounts.UnavailableError)(yield* failure("unreachable")))
    assert.deepEqual(
      yield* failure({ status: 404, raw: `{"message":"Account not found.","error":{"code":"account_not_found"}}` }),
      new PayableAccounts.RejectedError({ reason: "account_not_found" }),
    )
    assert.ok(Schema.is(PayableAccounts.CursorError)(yield* failure(refused("cursor"), { cursor: "forged" })))

    // Anything else refused is a request built wrong, so a defect.
    const exit = yield* Effect.exit(statementFrom(refused("from")).read)

    assert.ok(Exit.isFailure(exit) && Cause.hasDies(exit.cause))
  }),
))
