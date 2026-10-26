import { LedgerPostings } from "@pay-tty/core/ledger"
import { Config, Context, Duration, Effect, Layer, Queue, Schedule } from "effect"

/** The longest the relay waits between passes while the ledger is down. */
export const maxBackoff = Duration.minutes(1)

export interface Interface {
  /** Starts a pass now rather than at the next interval; it never waits on one. */
  readonly nudge: Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("Relay") {}

// Sends waiting postings to the ledger every interval, or sooner when nudged,
// for as long as the layer's scope is open.
const make = Effect.gen(function* () {
  const postings = yield* LedgerPostings.Service

  const interval = yield* Config.Duration("LEDGER_RELAY_INTERVAL").pipe(Config.withDefault(Duration.seconds(5)))

  // One pending wake-up at most: nudges during a pass start one more, not many.
  const wake = yield* Queue.sliding<void>(1)

  const backoff = Schedule.exponential(interval).pipe(
    Schedule.modifyDelay(({ duration }) => Effect.succeed(Duration.min(duration, maxBackoff))),
    Schedule.jittered,
  )

  // A defect is logged and retried like an outage, so one bad posting can't
  // stop the relay for good.
  const pass = postings.relay.pipe(
    Effect.tapDefect((defect) => Effect.logError("ledger relay pass died", defect)),
    Effect.sandbox,
    Effect.retry(backoff),
  )

  const idle = Effect.timeoutOption(Queue.take(wake), interval)

  yield* Effect.forkScoped(Effect.forever(Effect.andThen(pass, idle)))

  return Service.of({ nudge: Effect.asVoid(Queue.offer(wake, undefined)) })
})

export const layer = Layer.effect(Service)(make)

export * as Relay from "./relay.ts"
