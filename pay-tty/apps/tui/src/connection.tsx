import { render } from "@opentui/solid"
import { Effect, FiberSet, Stream, SubscriptionRef } from "effect"
import { createSignal } from "solid-js"

import { App } from "./app.tsx"
import { Session, type State } from "./session.ts"

/**
 * Runs one connection's screen until it closes. Everything it starts lives in
 * its scope, so closing it cancels its requests and nothing else.
 */
export const connect = (
  fingerprint: string,
  renderer: Parameters<typeof render>[1],
  onClose: (callback: () => void) => void,
  end: () => void,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const session = yield* Session.make(fingerprint)
      const [state, setState] = createSignal<State>(yield* SubscriptionRef.get(session.state))

      yield* Effect.forkScoped(
        Stream.runForEach(SubscriptionRef.changes(session.state), (next) => Effect.sync(() => setState(() => next))),
      )

      // Key handlers return at once; their requests run here.
      const run = yield* FiberSet.makeRuntime()

      const actions = {
        retry: () => void run(session.load),
        createBusiness: (name: string) => void run(session.createBusiness(name)),
        openLedger: () => void run(session.openLedger),
        quit: end,
      }

      yield* Effect.promise(() => render(() => <App state={state} actions={actions} />, renderer))
      yield* Effect.forkScoped(session.load)
      yield* Effect.callback<void>((resume) => onClose(() => resume(Effect.void)))
    }),
  )
