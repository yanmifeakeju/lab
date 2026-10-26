import { render } from "@opentui/solid"
import { Clock, Effect, FiberSet, Schedule, Stream, SubscriptionRef } from "effect"
import { createSignal } from "solid-js"

import { App } from "./app.tsx"
import { PayApp } from "./pay-app.tsx"
import { PaySession, type State as PayState } from "./pay-session.ts"
import type { Form } from "./payment-link.ts"
import type { State as PaymentState } from "./payments.ts"
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
  payCommand: (shareToken: string) => string,
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
        createBusiness: (name: string) => void run(session.createBusiness(name)),
        openAccount: () => void run(session.openAccount),
        managePayments: () => void run(session.managePayments),
        linkPayments: (id: string) => void run(session.linkPayments(id)),
        refreshPayments: () => void run(session.refreshPayments),
        filterPayments: (state: PaymentState | null) => void run(session.filterPayments(state)),
        morePayments: () => void run(session.morePayments),
        openPayment: (id: string) => void run(session.openPayment(id)),
        manageLinks: () => void run(session.manageLinks),
        refreshLinks: () => void run(session.refreshLinks),
        openLink: (id: string) => void run(session.openLink(id)),
        startPaymentLink: () => void run(session.startPaymentLink),
        createPaymentLink: (form: Form) => void run(session.createPaymentLink(form)),
        back: () => void run(session.back),
        retry: () => void run(session.retry),
        close: () => void run(session.close),
        quit: end,
      }

      yield* Effect.promise(() => render(() => <App state={state} actions={actions} payCommand={payCommand} />, renderer))
      yield* Effect.forkScoped(session.load)
      yield* Effect.callback<void>((resume) => onClose(() => resume(Effect.void)))
    }),
  )

/**
 * Runs a customer's screen for the link they connected to pay, until the
 * connection closes. It holds no merchant session.
 */
export const pay = (
  shareToken: string,
  renderer: Parameters<typeof render>[1],
  onClose: (callback: () => void) => void,
  end: () => void,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const session = yield* PaySession.make(shareToken)
      const [state, setState] = createSignal<PayState>(yield* SubscriptionRef.get(session.state))
      const [now, setNow] = createSignal(yield* Clock.currentTimeMillis)

      const tick = Effect.flatMap(Clock.currentTimeMillis, (millis) => Effect.sync(() => setNow(millis)))

      // The clock moves with each new screen too, so a payment that just
      // started never shows more time than its window.
      yield* Effect.forkScoped(
        Stream.runForEach(SubscriptionRef.changes(session.state), (next) =>
          Effect.andThen(tick, Effect.sync(() => setState(() => next))),
        ),
      )

      // The countdown, and the expiry once it runs out.
      yield* Effect.forkScoped(Effect.repeat(Effect.andThen(tick, session.expire), Schedule.spaced("1 second")))

      const run = yield* FiberSet.makeRuntime()

      const actions = {
        start: (amount: string) => void run(session.start(amount)),
        simulate: (outcome: PaySession.Outcome) => void run(session.simulate(outcome)),
        tryAgain: () => void run(session.tryAgain),
        retry: () => void run(session.retry),
        close: () => void run(session.close),
        quit: end,
      }

      yield* Effect.promise(() => render(() => <PayApp state={state} now={now} actions={actions} />, renderer))
      yield* Effect.forkScoped(session.load)
      yield* Effect.callback<void>((resume) => onClose(() => resume(Effect.void)))
    }),
  )
