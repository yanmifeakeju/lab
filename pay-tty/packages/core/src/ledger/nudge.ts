import { Context, Duration, Effect, Layer, Queue } from "effect"

export interface Interface {
  /** Signals the relay to run a pass immediately without blocking the caller. */
  readonly nudge: Effect.Effect<void>
  /** Waits for a nudge signal or until `interval` elapses. */
  readonly next: (interval: Duration.Duration) => Effect.Effect<void>
}

/**
 * Decouples relay wake-up signaling from the relay loop so domain services can
 * trigger a flush without depending on `Relay`.
 */
export class Service extends Context.Service<Service, Interface>()("RelayNudge") {}

const make = Effect.gen(function* () {
  // Sliding buffer of capacity 1 coalesces multiple nudges during an active pass into a single follow-up pass.
  const wake = yield* Queue.sliding<void>(1)

  return Service.of({
    nudge: Effect.asVoid(Queue.offer(wake, undefined)),
    next: (interval) => Effect.asVoid(Effect.timeoutOption(Queue.take(wake), interval)),
  })
})

export const layer = Layer.effect(Service)(make)

export * as RelayNudge from "./nudge.ts"
