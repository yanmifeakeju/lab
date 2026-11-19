import { LedgerPostings, RelayNudge } from "@pay-tty/core/ledger"
import { PayoutDispatcher } from "@pay-tty/core/payouts/dispatcher"
import { Config, Duration, Effect, Layer, Queue, Schedule } from "effect"

/** The longest the relay waits between passes while the ledger is down. */
export const maxBackoff = Duration.minutes(1)

// Sends waiting postings to the ledger every interval, or sooner when nudged,
// for as long as the layer's scope is open. The payout dispatcher runs on its
// own fiber every interval too, so a slow provider never holds up a posting
// and a stuck posting never holds up payouts; each relay pass wakes it early,
// so a payout just held goes out at once.
const make = Effect.gen(function* () {
  const postings = yield* LedgerPostings.Service
  const dispatcher = yield* PayoutDispatcher.Service
  const wake = yield* RelayNudge.Service

  const interval = yield* Config.Duration("LEDGER_RELAY_INTERVAL").pipe(Config.withDefault(Duration.seconds(5)))

  const backoff = Schedule.exponential(interval).pipe(
    Schedule.modifyDelay(({ duration }) => Effect.succeed(Duration.min(duration, maxBackoff))),
    Schedule.jittered,
  )

  // A defect is logged and retried like an outage, so one bad posting can't
  // stop the relay for good.
  const relay = postings.relay.pipe(
    Effect.tapDefect((defect) => Effect.logError("ledger relay pass died", defect)),
    Effect.sandbox,
    Effect.retry(backoff),
  )

  // One pending wake-up at most: passes during a dispatch start one more.
  const due = yield* Queue.sliding<void>(1)

  yield* Effect.forkScoped(
    Effect.forever(dispatcher.dispatch.pipe(Effect.andThen(Effect.timeoutOption(Queue.take(due), interval)))),
  )
  yield* Effect.forkScoped(
    Effect.forever(relay.pipe(Effect.andThen(Queue.offer(due, undefined)), Effect.andThen(wake.next(interval)))),
  )
})

export const layer = Layer.effectDiscard(make)

export * as Relay from "./relay.ts"
