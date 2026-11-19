import { Effect, Layer, Schema } from "effect"

import { PayoutProvider } from "../payouts/provider.ts"

// A scripted payout provider for dispatcher and webhook tests. It answers from
// `script`, which a test may change between passes, and records every call.

export type Status = PayoutProvider.Standing["status"]

export interface Script {
  /** How status checks answer; null fails them with `ProviderError`. */
  standing: Status | null
  /** Sends still to fail with `ProviderError` before one is answered. */
  unanswered: number
  /** Whether callbacks pass the provider's check; one that does is read as a JSON `Reported`. */
  signed: boolean
}

const Reported = Schema.fromJsonString(PayoutProvider.Reported)

/** The provider's ref for a payout, in sends and final answers alike. */
export const refOf = (payoutId: string) => PayoutProvider.ProviderRef.make(`prov_${payoutId}`)

export const scripted = (standing: Status | null = "unknown", unanswered = 0) => {
  const script: Script = { standing, unanswered, signed: true }
  const sends: Array<PayoutProvider.Transfer> = []
  const asked: Array<string> = []

  const service = PayoutProvider.Service.of({
    send: (transfer) =>
      Effect.suspend(() => {
        sends.push(transfer)

        if (script.unanswered > 0) {
          script.unanswered -= 1

          return Effect.fail(new PayoutProvider.ProviderError({ message: "no answer" }))
        }

        return Effect.succeed(refOf(transfer.payoutId))
      }),
    standing: (transfer) =>
      Effect.suspend(() => {
        asked.push(transfer.payoutId)

        const status = script.standing

        if (status === null) {
          return Effect.fail(new PayoutProvider.ProviderError({ message: "provider down" }))
        }

        return Effect.succeed<PayoutProvider.Standing>(
          status === "paid" || status === "unpaid" ? { status, providerRef: refOf(transfer.payoutId) } : { status },
        )
      }),
    callback: ({ body }) =>
      Effect.suspend(() => {
        if (!script.signed) {
          return Effect.fail(new PayoutProvider.InvalidCallback({ reason: "unauthenticated" }))
        }

        return Effect.fromOption(Schema.decodeOption(Reported)(body)).pipe(
          Effect.mapError(() => new PayoutProvider.InvalidCallback({ reason: "malformed" })),
        )
      }),
  })

  return { script, sends, asked, layer: Layer.succeed(PayoutProvider.Service, service) }
}

export * as ScriptedProvider from "./provider.ts"
