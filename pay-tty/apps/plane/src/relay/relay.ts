import { LedgerPostings, RelayNudge } from "@pay-tty/core/ledger"
import { Payments } from "@pay-tty/core/payments"
import { AutomaticPayouts } from "@pay-tty/core/payouts/automatic"
import { PayoutDispatcher } from "@pay-tty/core/payouts/dispatcher"
import { Config, Duration, Effect, Layer, Queue, Schedule } from "effect"

/** The longest the relay waits between passes while the ledger is down. */
export const maxBackoff = Duration.minutes(1)

/**
 * How often the daily automatic payout run looks for businesses still due. The
 * first look after 00:00 UTC does the day's run; later ones retry failures and
 * catch up after a restart.
 */
export const automaticEvery = Duration.minutes(1)

// Sends waiting postings to the ledger, pass after pass while each fills its
// batch, then every interval or sooner when nudged, for as long as the layer's
// scope is open. The payout dispatcher runs on its own fiber every interval
// too, so a slow provider never holds up a posting and a stuck posting never
// holds up payouts; a relay pass that comes back short wakes it early, so a
// payout just held goes out at once. Settlement marks due payments for capture
// the same way, and wakes the relay to send them. Automatic payouts run for
// the UTC date every `automaticEvery`.
const make = Effect.gen(function* () {
  const postings = yield* LedgerPostings.Service
  const dispatcher = yield* PayoutDispatcher.Service
  const payments = yield* Payments.Service
  const automatic = yield* AutomaticPayouts.Service
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

  const settle = payments.settle.pipe(
    Effect.tap((settled) => (settled > 0 ? wake.nudge : Effect.void)),
    Effect.tapDefect((defect) => Effect.logError("payment settlement pass died", defect)),
    Effect.sandbox,
    Effect.retry(backoff),
  )

  const payOut = Effect.gen(function* () {
    const created = yield* automatic.run(yield* automatic.today)

    if (created > 0) {
      yield* Effect.logInfo("automatic payouts created", created)
    }
  }).pipe(
    Effect.tapDefect((defect) => Effect.logError("automatic payout run died", defect)),
    Effect.sandbox,
    Effect.retry(backoff),
  )

  // One pending wake-up at most each: passes during a dispatch or settlement start one more.
  const due = yield* Queue.sliding<void>(1)
  const settling = yield* Queue.sliding<void>(1)

  yield* Effect.forkScoped(
    Effect.forever(dispatcher.dispatch.pipe(Effect.andThen(Effect.timeoutOption(Queue.take(due), interval)))),
  )
  yield* Effect.forkScoped(Effect.forever(payOut.pipe(Effect.andThen(Effect.sleep(automaticEvery)))))
  yield* Effect.forkScoped(
    Effect.forever(settle.pipe(Effect.andThen(Effect.timeoutOption(Queue.take(settling), interval)))),
  )
  yield* Effect.forkScoped(
    Effect.forever(
      relay.pipe(
        // A full batch may have more behind it, such as a night's captures, so
        // the next pass starts at once. The dispatcher and settlement are woken
        // once the queue drains; their own interval covers them meanwhile.
        Effect.flatMap((claimed) =>
          claimed < LedgerPostings.relayBatchSize
            ? Queue.offer(due, undefined).pipe(
              Effect.andThen(Queue.offer(settling, undefined)),
              Effect.andThen(wake.next(interval)),
            )
            : Effect.void
        ),
      ),
    ),
  )
})

export const layer = Layer.effectDiscard(make)

export * as Relay from "./relay.ts"
