import assert from "node:assert/strict"
import { after, test } from "node:test"

import { Testing } from "@pay-tty/database/testing"
import { Api, Signature } from "../src/api.ts"
import { eq, sql } from "drizzle-orm"
import { Clock, ConfigProvider, Duration, Effect, Fiber, Layer, Logger, type LogLevel, Option, Redacted, Schema } from "effect"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientError from "effect/unstable/http/HttpClientError"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import { ulid } from "ulid"

import { SimDatabase, layerUrl } from "../src/database.ts"
import { routes } from "../src/http/routes.ts"
import { Reporter } from "../src/payouts/reporter.ts"
import { providerPayouts } from "../src/payouts/sql.ts"
import { schema } from "../src/testing/setup.ts"

const apiKey = Redacted.make("sim-test-api-key")

const webhookSecret = Redacted.make("sim-test-webhook-secret")

// Longer than any test waits, so a transfer is final only once a test says so.
const config = (extra: Record<string, string> = {}) =>
  ConfigProvider.layerAdd(
    ConfigProvider.fromEnvRecord({ API_KEY: Redacted.value(apiKey), PAYOUT_DELAY: "48 hours", ...extra }),
    { asPrimary: true },
  )

const db = await Testing.withDatabase(schema)

const database = db.layer

const handlerOf = (layer: Layer.Layer<never>, over: Layer.Layer<SimDatabase> = database) =>
  HttpRouter.toWebHandler(routes.pipe(Layer.provide(over), Layer.provide(layer), Layer.orDie), { disableLogger: true })

const sim = handlerOf(config())

// Close the handler's pools, then drop, even if closing fails.
after(() => sim.dispose().finally(() => db.drop()))

const run = <A, E>(effect: Effect.Effect<A, E, SimDatabase>) =>
  Effect.runPromise(Effect.provide(effect, database))

// What the sim answers: a payout, or an error.
const Answer = Schema.fromJsonString(Schema.Struct({
  reference: Schema.optional(Schema.String),
  providerRef: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  error: Schema.optional(Schema.Struct({ code: Schema.String })),
}))

const SendBody = Schema.fromJsonString(Api.SendRequest)

const Callback = Schema.fromJsonString(Api.Callback)

// Where the client registered its callbacks.
const callbackUrl = new URL("http://plane.test/hooks/payout-outcomes")

interface Call {
  readonly method: "GET" | "POST"
  readonly path: string
  readonly body?: string
  // Left out, the call carries the right bearer token; null, no header.
  readonly authorization?: string | null
}

const fetchFrom = (app: typeof sim, { method, path, body = "", authorization = Signature.bearer(apiKey) }: Call) =>
  Effect.gen(function* () {
    const headers = authorization === null ? {} : { authorization }

    const response = yield* Effect.promise(() =>
      app.handler(new Request(`http://sim.test${path}`, method === "POST" ? { method, headers, body } : { method, headers })),
    )

    const text = yield* Effect.promise(() => response.text())

    return { status: response.status, json: yield* Schema.decodeEffect(Answer)(text) }
  })

const payout = (reference: string, accountNumber = "0123456789", amount = "2500000") =>
  Schema.encodeEffect(SendBody)({
    reference,
    ledger: "ngn_ng",
    currency: "NGN",
    amount,
    destination: { bankCode: "058", accountNumber, accountName: "Adaeze Studio" },
  }).pipe(Effect.orDie)

const send = (body: Effect.Effect<string>, app = sim) =>
  Effect.flatMap(body, (text) => fetchFrom(app, { method: "POST", path: Api.sendPath, body: text }))

const lookup = (reference: string, app = sim) => fetchFrom(app, { method: "GET", path: Api.lookupPath(reference) })

// The transfer's processing time is up.
const finish = (reference: string) =>
  Effect.gen(function* () {
    const database = yield* SimDatabase

    yield* database.use((db) =>
      db
        .update(providerPayouts)
        .set({ sentAt: sql`${providerPayouts.sentAt} - interval '49 hours'` })
        .where(eq(providerPayouts.reference, reference)),
    )
  })

// The payout's callback is due now, however long it was set to wait.
const due = (reference: string) =>
  Effect.gen(function* () {
    const database = yield* SimDatabase

    yield* database.use((db) =>
      db.update(providerPayouts).set({ nextCallbackAt: sql`now()` }).where(eq(providerPayouts.reference, reference)),
    )
  })

void test("a send is idempotent on its reference, and the same reference with other details is refused", () =>
  run(
    Effect.gen(function* () {
      const reference = `pout_${ulid()}`

      const first = yield* send(payout(reference))
      const again = yield* send(payout(reference))

      assert.deepEqual([first.status, again.status], [201, 200])
      assert.ok(first.json.providerRef?.startsWith("spo_"))
      assert.equal(again.json.providerRef, first.json.providerRef)

      assert.equal((yield* send(payout(reference, "0123456789", "2500001"))).status, 409)
      assert.equal((yield* send(payout(reference, "1111111111"))).status, 409)
    }),
  ))

void test("a lookup answers pending until the outcome is final, then paid or failed with the ref, and not found otherwise", () =>
  run(
    Effect.gen(function* () {
      const paid = `pout_${ulid()}`
      const failed = `pout_${ulid()}`
      const refs = [(yield* send(payout(paid))).json.providerRef, (yield* send(payout(failed, "0123450000"))).json.providerRef]

      assert.deepEqual((yield* lookup(paid)).json, { reference: paid, status: "pending", providerRef: refs[0] })

      yield* finish(paid)
      yield* finish(failed)

      assert.deepEqual((yield* lookup(paid)).json, { reference: paid, status: "paid", providerRef: refs[0] })
      assert.deepEqual((yield* lookup(failed)).json, { reference: failed, status: "failed", providerRef: refs[1] })
      assert.equal((yield* lookup(`pout_${ulid()}`)).status, 404)
    }),
  ))

void test("a call without the API key as its bearer token is refused, whether sending or looking up", () =>
  run(
    Effect.gen(function* () {
      const reference = `pout_${ulid()}`
      const body = yield* payout(reference)

      for (const authorization of [Signature.bearer(Redacted.make("wrong")), Signature.bearer(webhookSecret), Redacted.value(apiKey), null]) {
        assert.equal((yield* fetchFrom(sim, { method: "POST", path: Api.sendPath, body, authorization })).status, 401)
        assert.equal((yield* fetchFrom(sim, { method: "GET", path: Api.lookupPath(reference), authorization })).status, 401)
      }

      // Nothing was taken.
      assert.equal((yield* lookup(reference)).status, 404)
    }),
  ))

void test("a database failure answers 500, and the server keeps serving", () =>
  run(
    Effect.gen(function* () {
      const broken = handlerOf(config(), layerUrl(Redacted.make(Testing.unassigned)))

      yield* Effect.gen(function* () {
        assert.equal((yield* send(payout(`pout_${ulid()}`), broken)).status, 500)
        assert.equal((yield* lookup(`pout_${ulid()}`, broken)).status, 500)
      }).pipe(Effect.ensuring(Effect.promise(() => broken.dispose())))
    }),
  ))

void test("the reporter calls back with each final outcome until plane takes it, and then never again", () =>
  run(
    Effect.gen(function* () {
      const reference = `pout_${ulid()}`
      const providerRef = (yield* send(payout(reference))).json.providerRef

      yield* finish(reference)

      const callbacks: Array<{ readonly body: string; readonly id: string | null; readonly valid: boolean }> = []
      // Plane is down for this payout's first callback.
      let down = true

      const plane = HttpClient.make((request) =>
        Effect.gen(function* () {
          const web = yield* Effect.orDie(HttpClientRequest.toWeb(request))
          const body = yield* Effect.promise(() => web.text())
          const valid = yield* Signature.verify(webhookSecret, Object.fromEntries(web.headers.entries()), body)

          callbacks.push({ body, id: web.headers.get(Signature.idHeader), valid })

          const failing = down && body.includes(reference)

          down = down && !failing

          return HttpClientResponse.fromWeb(request, new Response(null, { status: failing ? 503 : 204 }))
        }),
      )

      const options = { delay: Duration.hours(48), callbackUrl, secret: webhookSecret }
      const pass = Reporter.pass(options).pipe(Effect.provideService(HttpClient.HttpClient, plane))
      const ours = () => callbacks.filter(({ body }) => body.includes(reference))

      // Refused: it waits rather than going out again on the next pass.
      yield* pass
      yield* pass
      assert.equal(ours().length, 1)

      yield* due(reference)
      yield* pass
      yield* pass

      assert.equal(ours().length, 2)
      assert.ok(ours().every(({ valid }) => valid))
      // The retry is the same callback.
      assert.ok(ours()[0]?.id !== null && ours()[0]?.id === ours()[1]?.id)
      assert.deepEqual(yield* Schema.decodeEffect(Callback)(ours()[1]?.body ?? ""), { reference, outcome: "paid", providerRef })
    }),
  ))

void test("the running reporter retries a refused callback with doubling waits, a new one starts from the first wait, and neither backs off the passes", () =>
  run(
    Effect.gen(function* () {
      const every = 10
      const first = `pout_${ulid()}`
      const second = `pout_${ulid()}`
      // When each of our payouts' callbacks arrived, and how many to refuse before taking one.
      const attempts = new Map<string, Array<number>>([[first, []], [second, []]])
      const refusals = new Map([[first, 5], [second, 1]])
      const logs: Array<readonly [LogLevel.LogLevel, unknown]> = []

      const plane = HttpClient.make((request) =>
        Effect.gen(function* () {
          const web = yield* Effect.orDie(HttpClientRequest.toWeb(request))
          const { reference } = yield* Schema.decodeEffect(Callback)(yield* Effect.promise(() => web.text())).pipe(Effect.orDie)
          const at = attempts.get(reference)
          const left = refusals.get(reference) ?? 0

          at?.push(yield* Clock.currentTimeMillis)
          refusals.set(reference, left - 1)

          return HttpClientResponse.fromWeb(request, new Response(null, { status: at !== undefined && left > 0 ? 503 : 204 }))
        }),
      )

      const until = (done: () => boolean, what: string) =>
        Effect.gen(function* () {
          for (let tries = 0; tries < 1000; tries++) {
            if (done()) {
              return
            }

            yield* Effect.sleep("5 millis")
          }

          assert.fail(`never ${what}`)
        })

      const calledBack = (reference: string, count: number) =>
        until(() => (attempts.get(reference)?.length ?? 0) >= count, `${count} callbacks for ${reference}`)

      const gaps = (reference: string) => {
        const times = attempts.get(reference) ?? []

        return times.slice(1).map((time, index) => time - (times[index] ?? time))
      }

      const options = { delay: Duration.hours(48), callbackUrl, secret: webhookSecret, retry: { first: Duration.millis(every), attempts: 10 } }

      yield* send(payout(first))
      yield* finish(first)

      const reporter = yield* Reporter.run(options, Duration.millis(every), Duration.seconds(1)).pipe(
        Effect.provideService(HttpClient.HttpClient, plane),
        Effect.provide(Logger.layer([Logger.make(({ logLevel, message }) => {
          logs.push([logLevel, message])
        })])),
        Effect.forkChild,
      )

      // Five refused, then taken: each wait doubles from the first.
      yield* calledBack(first, 6)

      gaps(first).forEach((gap, index) => assert.ok(gap >= every * 2 ** index - 2, `gap ${index}: ${gap}ms`))

      // A new failure starts again from the first wait, not from where the last run of failures stopped.
      yield* send(payout(second))
      yield* finish(second)
      yield* calledBack(second, 2)
      yield* Fiber.interrupt(reporter)

      const [restart = Infinity] = gaps(second)

      assert.ok(restart < every * 2 ** 4, `restart gap: ${restart}ms`)

      // Each refused attempt warns; none fails its pass, so the loop never backs off.
      const retrying = ["Warn", ["callback failed; retrying"]] as const

      assert.deepEqual(logs, Array<typeof retrying>(6).fill(retrying))
    }),
  ))

// Plane, answering each callback with `answer` for its reference (204 for any
// other's), unreachable, or silent forever; counting each reference's callbacks.
const planeAnswering = (answer: (reference: string, attempt: number) => number | "unreachable" | "silent") => {
  const calls = new Map<string, number>()

  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      const web = yield* Effect.orDie(HttpClientRequest.toWeb(request))
      const { reference } = yield* Schema.decodeEffect(Callback)(yield* Effect.promise(() => web.text())).pipe(Effect.orDie)
      const attempt = (calls.get(reference) ?? 0) + 1

      calls.set(reference, attempt)

      const status = answer(reference, attempt)

      if (status === "silent") {
        return yield* Effect.never
      }

      if (status === "unreachable") {
        return yield* new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, description: "connection refused" }),
        })
      }

      return HttpClientResponse.fromWeb(request, new Response(null, { status }))
    }),
  )

  return { calls, client }
}

// One reporter pass with the production retry policy.
const passWith = (client: HttpClient.HttpClient, timeout = Reporter.callbackTimeout) =>
  Reporter.pass({ delay: Duration.hours(48), callbackUrl, secret: webhookSecret, timeout }).pipe(
    Effect.provideService(HttpClient.HttpClient, client),
  )

// A payout's callback state: attempts, last status, whether given up, and the wait before the next attempt in seconds.
const callbackState = (reference: string) =>
  Effect.gen(function* () {
    const database = yield* SimDatabase

    const result = yield* database.use((db) =>
      db.execute<{ attempts: number; status: number | null; abandoned: boolean; wait: number | null }>(sql`
        select callback_attempts as attempts, callback_status as status, callback_abandoned_at is not null as abandoned,
          round(extract(epoch from next_callback_at - now()))::int as wait
        from provider_payouts where reference = ${reference}
      `),
    )

    return result.rows[0] ?? assert.fail(`no payout ${reference}`)
  })

// A final payout the sim has taken, its outcome due for a callback.
const finished = Effect.gen(function* () {
  const reference = `pout_${ulid()}`

  yield* send(payout(reference))
  yield* finish(reference)

  return reference
})

void test("a callback plane keeps refusing waits 30s, then twice as long each time, and is given up after its 10th attempt, while others still go out", () =>
  run(
    Effect.gen(function* () {
      const refused = yield* finished
      const taken = yield* finished
      const plane = planeAnswering((reference) => (reference === refused ? 400 : 204))
      const logs: Array<readonly [LogLevel.LogLevel, unknown]> = []

      const capture = Logger.layer([Logger.make(({ logLevel, message }) => {
        logs.push([logLevel, message])
      })])

      const passOnce = passWith(plane.client).pipe(Effect.provide(capture))

      yield* passOnce

      // The other row went out in the same pass.
      assert.deepEqual([plane.calls.get(refused), plane.calls.get(taken)], [1, 1])
      assert.deepEqual(yield* callbackState(refused), { attempts: 1, status: 400, abandoned: false, wait: 30 })

      for (let attempt = 2; attempt <= 9; attempt++) {
        yield* due(refused)
        yield* passOnce

        assert.deepEqual(yield* callbackState(refused), { attempts: attempt, status: 400, abandoned: false, wait: 30 * 2 ** (attempt - 1) })
      }

      yield* due(refused)
      yield* passOnce

      assert.deepEqual(yield* callbackState(refused), { attempts: 10, status: 400, abandoned: true, wait: 30 * 2 ** 9 })

      // Given up: never sent again.
      yield* due(refused)
      yield* passOnce
      assert.equal(plane.calls.get(refused), 10)

      // A warning for each failed attempt, then an error when it's given up.
      const retrying = ["Warn", ["callback failed; retrying"]] as const

      assert.deepEqual(logs, [...Array<typeof retrying>(9).fill(retrying), ["Error", ["callback given up after its last attempt"]]])
    }),
  ))

void test("a callback answered 500, 429, or not at all is retried, and is delivered once plane takes it", () =>
  run(
    Effect.gen(function* () {
      const reference = yield* finished
      const answers = [500, 429, "unreachable", 204] as const
      const plane = planeAnswering((_, attempt) => answers[attempt - 1] ?? 204)

      for (const status of [500, 429, null]) {
        yield* passWith(plane.client)

        const state = yield* callbackState(reference)

        assert.deepEqual([state.status, state.abandoned], [status, false], String(status))

        yield* due(reference)
      }

      yield* passWith(plane.client)

      assert.equal(plane.calls.get(reference), 4)
      assert.equal((yield* passWith(plane.client), plane.calls.get(reference)), 4)
    }),
  ))

void test("a row whose callback can't be encoded is given up at once, and the rest still go out", () =>
  run(
    Effect.gen(function* () {
      const database = yield* SimDatabase
      const blank = yield* finished
      const taken = yield* finished
      const plane = planeAnswering(() => 204)

      // A ref the callback's schema refuses.
      yield* database.use((db) => db.update(providerPayouts).set({ providerRef: " " }).where(eq(providerPayouts.reference, blank)))
      yield* passWith(plane.client)

      assert.deepEqual([plane.calls.get(blank), plane.calls.get(taken)], [undefined, 1])
      assert.equal((yield* callbackState(blank)).abandoned, true)
    }),
  ))

void test("a callback plane never answers fails its attempt at the timeout, and a later row in the same pass still goes out", () =>
  run(
    Effect.gen(function* () {
      const silent = yield* finished
      const taken = yield* finished
      const plane = planeAnswering((reference) => (reference === silent ? "silent" : 204))

      // Bounded, so a missing timeout fails here instead of hanging the suite.
      const finishedPass = yield* passWith(plane.client, Duration.millis(50)).pipe(Effect.timeout("5 seconds"), Effect.option)

      assert.ok(Option.isSome(finishedPass), "the pass never finished")

      const state = yield* callbackState(silent)

      assert.deepEqual([state.attempts, state.status, state.abandoned, state.wait], [1, null, false, 30])
      assert.deepEqual([plane.calls.get(silent), plane.calls.get(taken)], [1, 1])
    }),
  ))

