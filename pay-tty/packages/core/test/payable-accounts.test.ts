import assert from "node:assert/strict"
import { test } from "node:test"

import { ConfigProvider, Effect, Layer, Schema } from "effect"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientError from "effect/unstable/http/HttpClientError"
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
const balanceFrom = (reply: Reply) => {
  const paths: Array<string> = []

  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      paths.push(new URL(request.url).pathname)

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

  const balance = Effect.gen(function* () {
    const accounts = yield* PayableAccounts.Service

    return yield* accounts.balance({ accountRef, ledger })
  }).pipe(Effect.provide(layer))

  return { paths, balance }
}

const failureOf = (reply: Reply) => Effect.flip(balanceFrom(reply).balance)

const run = <A, E>(effect: Effect.Effect<A, E>) => () => Effect.runPromise(effect)

void test("a balance is the account's available amount and its pending credits", run(
  Effect.gen(function* () {
    const { paths, balance } = balanceFrom(account(counters(9_800, 1_500)))

    assert.deepEqual(yield* balance, new PayableAccounts.Balance({ available: 9_800n, pending: 1_500n }))
    assert.deepEqual(paths, [`/accounts/${accountRef}`])
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
