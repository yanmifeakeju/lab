import { Api, Signature } from "../api.ts"
import { Config, Duration, Effect, Exit, Layer, Redacted, Result, Schema } from "effect"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"

import { SimDatabase } from "../database.ts"
import { defaultDelay } from "../http/routes.ts"
import { Store } from "./store.ts"

/** The wait between passes while they succeed, and the first after a failed pass. */
export const reportEvery = Duration.seconds(1)

/** The longest wait between failing passes. */
export const maxBackoff = Duration.seconds(60)

/** The wait after a callback's first failed attempt; it doubles after each. */
export const callbackFirstWait = Duration.seconds(30)

/** Delivery attempts a callback gets before it's given up. */
export const callbackAttempts = 10

/** How long plane has to answer a callback; past it, the attempt failed. */
export const callbackTimeout = Duration.seconds(10)

const CallbackBody = Schema.fromJsonString(Api.Callback)

export interface Options {
  readonly delay: Duration.Duration
  readonly callbackUrl: URL
  readonly secret: Redacted.Redacted
  /** Unless given, `callbackFirstWait` doubling, for `callbackAttempts` attempts. */
  readonly retry?: Store.Retry
  /** Unless given, `callbackTimeout`. */
  readonly timeout?: Duration.Duration
}

type Due = Effect.Success<typeof Store.unreported>[number]

// Delivers one callback. Any failure only reschedules this row, or gives it up.
const deliver = (client: HttpClient.HttpClient, options: Options, retry: Store.Retry, { reference, providerRef, outcome }: Due) =>
  Effect.gen(function* () {
    const encoded = yield* Effect.result(Schema.encodeEffect(CallbackBody)({ reference, outcome, providerRef }))

    if (Result.isFailure(encoded)) {
      yield* Store.abandonCallback(providerRef)

      return yield* Effect.logError("callback can't be encoded; given up", encoded.failure).pipe(Effect.annotateLogs({ reference }))
    }

    // One id per callback, the same on every retry.
    const headers = yield* Signature.sign(options.secret, `msg_${providerRef}`, encoded.success)

    // A timeout is no answer, like a transport error.
    const answered = yield* Effect.result(client.execute(
      HttpClientRequest.post(options.callbackUrl).pipe(
        HttpClientRequest.bodyText(encoded.success, "application/json"),
        HttpClientRequest.setHeaders(headers),
      ),
    ).pipe(Effect.timeout(options.timeout ?? callbackTimeout)))

    const status = Result.isSuccess(answered) ? answered.success.status : null

    if (status !== null && status >= 200 && status < 300) {
      return yield* Store.markReported(providerRef)
    }

    const failed = yield* Store.callbackFailed(providerRef, status, retry)

    if (failed.abandoned) {
      return yield* Effect.logError("callback given up after its last attempt").pipe(
        Effect.annotateLogs({ reference, status, attempts: failed.attempts }),
      )
    }

    yield* Effect.logWarning("callback failed; retrying").pipe(
      Effect.annotateLogs({ reference, status, attempt: failed.attempts, of: retry.attempts, next: failed.nextAt }),
    )
  })

/**
 * Finalises transfers whose delay has passed, then delivers each callback that
 * is due, oldest first. Each is delivered on its own: a failed one waits,
 * doubling, and is given up after its last attempt, without holding up the rest.
 */
export const pass = (options: Options) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const retry = options.retry ?? { first: callbackFirstWait, attempts: callbackAttempts }

    yield* Store.settleDue(options.delay)

    const due = yield* Store.unreported

    yield* Effect.forEach(due, (row) => deliver(client, options, retry, row), { discard: true })

    return due.length
  })

const backoff = (failures: number, every: Duration.Duration, max: Duration.Duration) =>
  failures === 0 ? every : Duration.min(Duration.times(every, 2 ** Math.min(failures - 1, 30)), max)

/**
 * Runs passes forever: every `every` while they succeed, backing off by
 * doubling to `max` while whole passes fail, as with the database down; a
 * callback's own failure doesn't fail its pass. Warns when failures start and
 * logs once they stop.
 */
export const run = (options: Options, every: Duration.Duration = reportEvery, max: Duration.Duration = maxBackoff) => {
  const loop = (failures: number): Effect.Effect<never, never, HttpClient.HttpClient | SimDatabase> =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(pass(options))

      if (Exit.isSuccess(exit)) {
        if (failures > 0) {
          yield* Effect.logInfo("simulated payout reporter recovered", { failures })
        }

        return 0
      }

      if (failures === 0) {
        yield* Effect.logWarning("simulated payout reporter is failing; backing off", exit.cause)
      }

      return failures + 1
    }).pipe(Effect.flatMap((next) => Effect.andThen(Effect.sleep(backoff(next, every, max)), loop(next))))

  return loop(0)
}

/** The reporter from PLANE_CALLBACK_URL, WEBHOOK_SECRET and PAYOUT_DELAY, for as long as the layer lives. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const options: Options = {
      delay: yield* Config.Duration("PAYOUT_DELAY").pipe(Config.withDefault(defaultDelay)),
      callbackUrl: new URL(yield* Config.String("PLANE_CALLBACK_URL")),
      secret: yield* Config.Redacted("WEBHOOK_SECRET"),
    }

    yield* Effect.forkScoped(run(options))
  }),
)

export * as Reporter from "./reporter.ts"
