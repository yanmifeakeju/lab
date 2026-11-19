import assert from "node:assert/strict"
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { createServer, type Server } from "node:http"
import { after, test } from "node:test"

import { Api, Signature } from "@pay-tty/sim/api"
import { ConfigProvider, Effect, Layer, Redacted, Schema } from "effect"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import { ulid } from "ulid"

import { Ledger } from "../../../ledger/slug.ts"
import { SimProvider } from "./adapter.ts"
import { Payouts } from "../../payouts.ts"
import { PayoutProvider } from "../../provider.ts"

// The adapter against a stub of the sim's HTTP API, answering as each test
// says. These pin down the adapter's current reading of each answer.

const apiKey = Redacted.make("adapter-test-api-key")

const webhookSecret = Redacted.make("adapter-test-webhook-secret")

interface Received {
  readonly method: string
  readonly path: string
  readonly headers: Record<string, string | undefined>
  readonly body: string
}

type Json = string | number | boolean | null | ReadonlyArray<Json> | { readonly [key: string]: Json }

interface Answer {
  readonly status: number
  // Sent as JSON; left out, with `raw` sent as is, or no body at all.
  readonly body?: Json
  readonly raw?: string
}

const toJson = (body: Json) => Effect.runSync(Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(body).pipe(Effect.orDie))

const received: Array<Received> = []

let answer: Answer = { status: 500 }

const stub = createServer((request, response) => {
  let body = ""

  request.setEncoding("utf8")
  request.on("data", (chunk: string) => {
    body += chunk
  })
  request.on("end", () => {
    const headers = Object.fromEntries(
      Object.entries(request.headers).map(([name, value]) => [name, Array.isArray(value) ? value.join(",") : value]),
    )

    received.push({ method: request.method ?? "", path: request.url ?? "", headers, body })
    const text = answer.body === undefined ? answer.raw : toJson(answer.body)

    response.writeHead(answer.status, text === undefined ? {} : { "content-type": "application/json" })
    response.end(text)
  })
})

const isListening = Schema.is(Schema.Struct({ port: Schema.Finite }))

// Listens on a free port, and answers with its origin.
const listen = (server: Server) =>
  Effect.callback<string>((resume) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()

      resume(
        isListening(address)
          ? Effect.succeed(`http://127.0.0.1:${address.port}`)
          : Effect.die(new Error("the stub has no port")),
      )
    })
  })

const close = (server: Server) =>
  Effect.callback<void>((resume) => {
    server.close(() => resume(Effect.void))
  })

const origin = await Effect.runPromise(listen(stub))

after(() => Effect.runPromise(close(stub)))

const provider = (simUrl = origin) =>
  SimProvider.layer.pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ SIM_URL: simUrl, SIM_API_KEY: Redacted.value(apiKey), SIM_WEBHOOK_SECRET: Redacted.value(webhookSecret) }))),
    Layer.orDie,
  )

const transfer = (payoutId = Payouts.ID.make(`pout_${ulid()}`), amount = 2_500_000n) =>
  new PayoutProvider.Transfer({
    payoutId,
    ledger: Ledger.Slug.make("ngn_ng"),
    currencyCode: "NGN",
    amount,
    destination: new Payouts.Destination({ bankCode: "058", accountNumber: "0123456789", accountName: "Adaeze Studio" }),
    providerRef: null,
  })

const answering = (next: Answer) =>
  Effect.sync(() => {
    answer = next
  })

// What a call came to: its value, or its error's tag.
const settle = <A, E extends { readonly _tag: string }>(effect: Effect.Effect<A, E>) =>
  Effect.match(effect, { onSuccess: (ok) => ({ ok }), onFailure: (error) => ({ error: error._tag }) })

const providerError = { error: "PayoutProvider.ProviderError" }

// The payout every send in these tests is for.
const sending = Payouts.ID.make(`pout_${ulid()}`)

const sendAs = (next: Answer, simUrl?: string) =>
  Effect.gen(function* () {
    yield* answering(next)

    const service = yield* PayoutProvider.Service

    return yield* settle(service.send(transfer(sending)))
  }).pipe(Effect.provide(provider(simUrl)))

const standingAs = (next: Answer, payout = transfer()) =>
  Effect.gen(function* () {
    yield* answering(next)

    const service = yield* PayoutProvider.Service

    return yield* settle(service.standing(payout))
  }).pipe(Effect.provide(provider()))

const last = () => received.at(-1) ?? assert.fail("the stub received nothing")


const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

void test("a send is a POST of the transfer with the API key as its bearer token, and a 201 or a 200 with a ref returns the ref", () =>
  run(
    Effect.gen(function* () {
      for (const status of [201, 200]) {
        const result = yield* sendAs({ status, body: { reference: sending, providerRef: "spo_1" } })

        assert.deepEqual(result, { ok: "spo_1" }, String(status))
      }

      const request = last()

      assert.deepEqual([request.method, request.path], ["POST", Api.sendPath])
      assert.equal(request.headers["authorization"], Signature.bearer(apiKey))

      const sent = yield* Schema.decodeEffect(Schema.fromJsonString(Api.SendRequest))(request.body)

      assert.deepEqual([sent.amount, sent.currency, sent.destination.accountNumber], ["2500000", "NGN", "0123456789"])
    }),
  ))

void test("a send answered 400, 409 or 422 is refused, naming the sim's error; any other failure is a provider error", () =>
  run(
    Effect.gen(function* () {
      const refused = { error: "PayoutProvider.RefusedError" }

      for (const status of [400, 409, 422]) {
        assert.deepEqual(yield* sendAs({ status, body: { error: { code: "x" } } }), refused, String(status))
      }

      // A bad key, a wrong route, a timeout or a rate limit recovers once fixed or past.
      for (const status of [401, 403, 404, 408, 429, 500, 503]) {
        assert.deepEqual(yield* sendAs({ status, body: { error: { code: "x" } } }), providerError, String(status))
      }

      yield* answering({ status: 400, body: { error: { code: Api.errors.invalidPayout } } })

      const refusal = yield* Effect.gen(function* () {
        const service = yield* PayoutProvider.Service

        return yield* Effect.flip(service.send(transfer(sending)))
      }).pipe(Effect.provide(provider()))

      assert.equal(refusal.message, "provider refused the payout with 400 (invalid_payout)")
    }),
  ))

void test("a transfer the sim's API can't carry is refused before any request", () =>
  run(
    Effect.gen(function* () {
      const before = received.length
      // Seventeen digits; the sim takes at most sixteen.
      const huge = transfer(undefined, 10n ** 16n)

      const result = yield* Effect.gen(function* () {
        const service = yield* PayoutProvider.Service

        return yield* settle(service.send(huge))
      }).pipe(Effect.provide(provider()))

      assert.deepEqual([result, received.length], [{ error: "PayoutProvider.RefusedError" }, before])
    }),
  ))

void test("a send answer without a ref, with an empty or blank one, or for another reference is a provider error", () =>
  run(
    Effect.gen(function* () {
      assert.deepEqual(yield* sendAs({ status: 201, body: { reference: `pout_${ulid()}`, providerRef: "spo_1" } }), providerError)
      assert.deepEqual(yield* sendAs({ status: 201, body: { reference: sending } }), providerError)
      assert.deepEqual(yield* sendAs({ status: 201, raw: "not json" }), providerError)

      for (const providerRef of ["", " "]) {
        assert.deepEqual(yield* sendAs({ status: 201, body: { reference: sending, providerRef } }), providerError, `ref "${providerRef}"`)
      }
    }),
  ))

void test("a status check is a GET of the payout's path with the API key as its bearer token, and pending, paid and failed each map", () =>
  run(
    Effect.gen(function* () {
      const payout = transfer()
      const of = (status: string) => ({ reference: payout.payoutId, status, providerRef: "spo_1" })

      assert.deepEqual(yield* standingAs({ status: 200, body: of("pending") }, payout), { ok: { status: "pending" } })

      const request = last()

      assert.deepEqual([request.method, request.path, request.body], ["GET", Api.lookupPath(payout.payoutId), ""])
      assert.equal(request.headers["authorization"], Signature.bearer(apiKey))

      assert.deepEqual(yield* standingAs({ status: 200, body: of("paid") }, payout), { ok: { status: "paid", providerRef: "spo_1" } })
      assert.deepEqual(yield* standingAs({ status: 200, body: of("failed") }, payout), { ok: { status: "unpaid", providerRef: "spo_1" } })
    }),
  ))

void test("a status check answered 404 is not received only with the sim's not_found error; any other 404 is a provider error", () =>
  run(
    Effect.gen(function* () {
      const notReceived = { ok: { status: "not_received" } }

      assert.deepEqual(yield* standingAs({ status: 404, body: { error: { code: Api.errors.notFound } } }), notReceived)
      assert.deepEqual(yield* standingAs({ status: 404 }), providerError)
      assert.deepEqual(yield* standingAs({ status: 404, raw: "<html>Not Found</html>" }), providerError)
      assert.deepEqual(yield* standingAs({ status: 404, body: { error: { code: "route_not_found" } } }), providerError)
    }),
  ))

void test("a status check answered anything but 200 or 404 is a provider error", () =>
  run(
    Effect.gen(function* () {
      for (const status of [201, 400, 401, 409, 500, 503]) {
        assert.deepEqual(yield* standingAs({ status, body: { error: { code: "x" } } }), providerError, String(status))
      }
    }),
  ))

void test("a final status answer without a ref, with an empty or blank one, with an unknown status, or for another reference is a provider error; a pending one's ref is ignored", () =>
  run(
    Effect.gen(function* () {
      const payout = transfer()

      for (const status of ["pending", "paid", "failed"]) {
        const answered = yield* standingAs({ status: 200, body: { reference: `pout_${ulid()}`, status, providerRef: "spo_1" } }, payout)

        assert.deepEqual(answered, providerError, `another reference, ${status}`)
      }

      const finalWithoutRef = [
        { status: "paid" },
        { status: "failed" },
        { status: "paid", providerRef: "" },
        { status: "failed", providerRef: " " },
        { status: "settled", providerRef: "spo_1" },
      ]

      for (const body of finalWithoutRef) {
        const answered = yield* standingAs({ status: 200, body: { reference: payout.payoutId, ...body } }, payout)

        assert.deepEqual(answered, providerError, `${body.status} with ref "${body.providerRef ?? "none"}"`)
      }

      // A pending answer's ref, if any, is ignored.
      for (const providerRef of [undefined, "", null]) {
        const body = providerRef === undefined ? { reference: payout.payoutId, status: "pending" } : { reference: payout.payoutId, status: "pending", providerRef }

        assert.deepEqual(yield* standingAs({ status: 200, body }, payout), { ok: { status: "pending" } }, `ref ${String(providerRef)}`)
      }
    }),
  ))

void test("an unreachable provider is a provider error, for a send and a status check", () =>
  run(
    Effect.gen(function* () {
      // A port that was free a moment ago, with nothing listening on it now.
      const closed = createServer()
      const nowhere = yield* listen(closed)

      yield* close(closed)

      const unreachable = Effect.gen(function* () {
        const service = yield* PayoutProvider.Service

        return [yield* settle(service.send(transfer())), yield* settle(service.standing(transfer()))]
      }).pipe(Effect.provide(provider(nowhere)))

      for (const result of yield* unreachable) {
        assert.deepEqual(result, providerError)
      }
    }),
  ))

void test("a path prefix on SIM_URL is kept: requests go to the sim's paths under it", () =>
  run(
    Effect.gen(function* () {
      for (const prefix of ["/sim", "/sim/"]) {
        yield* sendAs({ status: 201, body: { reference: sending, providerRef: "spo_1" } }, `${origin}${prefix}`)

        assert.equal(last().path, `/sim${Api.sendPath}`, prefix)
      }
    }),
  ))

interface Signing {
  readonly signer?: Redacted.Redacted
  readonly secondsAgo?: number
  // A header the callback arrives without.
  readonly without?: keyof Signature.Signed
}

// The adapter reading `body` as a callback the sim signed as `signing` says. It
// carries no path, so where plane received it, after any proxy rewrite, doesn't matter.
const callbackAs = (body: string, { signer = webhookSecret, secondsAgo = 0, without }: Signing = {}) =>
  Effect.gen(function* () {
    const signed: Partial<Signature.Signed> = yield* Signature.sign(signer, "msg_1", body)
    const service = yield* PayoutProvider.Service

    signed[Signature.timestampHeader] = String(Number(signed[Signature.timestampHeader]) - secondsAgo)

    if (without !== undefined) {
      delete signed[without]
    }

    return yield* settle(service.callback({ headers: signed, body }))
  }).pipe(Effect.provide(provider()))

const callbackBody = (callback: typeof Api.Callback.Type) => Schema.encodeEffect(Schema.fromJsonString(Api.Callback))(callback)

void test("a callback signed with the webhook secret is read; one signed with the API key or another secret, a stale one, or one missing a header is unauthenticated", () =>
  run(
    Effect.gen(function* () {
      const payoutId = Payouts.ID.make(`pout_${ulid()}`)
      const body = yield* callbackBody({ reference: payoutId, outcome: "failed", providerRef: "spo_1" })
      const unauthenticated = { error: "PayoutProvider.InvalidCallback" }

      assert.deepEqual(yield* callbackAs(body), { ok: new PayoutProvider.Reported({ payoutId, outcome: "failed", providerRef: PayoutProvider.ProviderRef.make("spo_1") }) })
      assert.deepEqual(yield* callbackAs(body, { signer: apiKey }), unauthenticated)
      assert.deepEqual(yield* callbackAs(body, { signer: Redacted.make("another secret") }), unauthenticated)
      assert.deepEqual(yield* callbackAs(body, { secondsAgo: 600 }), unauthenticated)

      for (const without of [Signature.idHeader, Signature.timestampHeader, Signature.signatureHeader] as const) {
        assert.deepEqual(yield* callbackAs(body, { without }), unauthenticated, without)
      }
    }),
  ))

void test("a signed callback the adapter can't read is malformed, not unauthenticated", () =>
  run(
    Effect.gen(function* () {
      const reasons = Effect.fnUntraced(function* (body: string) {
        const read = yield* Effect.gen(function* () {
          const service = yield* PayoutProvider.Service

          const headers = yield* Signature.sign(webhookSecret, "msg_1", body)

          return yield* Effect.flip(service.callback({ headers, body }))
        }).pipe(Effect.provide(provider()))

        return read.reason
      })

      const payoutId = `pout_${ulid()}`

      const bodies = [
        "not json",
        `{"reference":"${payoutId}","outcome":"settled","providerRef":"spo_1"}`,
        `{"reference":"payout_1","outcome":"paid","providerRef":"spo_1"}`,
        `{"reference":"${payoutId}","outcome":"paid","providerRef":" "}`,
      ]

      for (const body of bodies) {
        assert.equal(yield* reasons(body), "malformed", body)
      }
    }),
  ))

void test("an API key equal to the webhook secret is refused at startup", () =>
  run(
    Effect.gen(function* () {
      const same = { SIM_URL: origin, SIM_API_KEY: "one-value", SIM_WEBHOOK_SECRET: "one-value" }

      const exit = yield* Effect.exit(
        Effect.scoped(Layer.build(SimProvider.layer.pipe(
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(same))),
        ))),
      )

      assert.equal(exit._tag, "Failure")
    }),
  ))
