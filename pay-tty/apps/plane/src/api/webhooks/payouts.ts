import { Payouts } from "@pay-tty/core/payouts"
import { PayoutProvider } from "@pay-tty/core/payouts/provider"
import { Effect, Layer } from "effect"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"

/** Where plane takes payout outcomes; the provider is given the full URL. */
export const path = "/webhooks/payouts"

const error = (status: number, code: string) => HttpServerResponse.jsonUnsafe({ error: { code } }, { status })

/**
 * The payout provider's callback with a payout's outcome, read by its
 * adapter. Any it reads is acknowledged, even for a payout already settled or
 * unknown here, so the provider stops sending it; `report` decides.
 */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const payouts = yield* Payouts.Service
    const provider = yield* PayoutProvider.Service

    const handle = (request: HttpServerRequest.HttpServerRequest) =>
      Effect.gen(function* () {
        const body = yield* request.text.pipe(Effect.orElseSucceed(() => null))

        if (body === null) {
          return error(401, "unauthorized")
        }

        return yield* provider.callback({ headers: request.headers, body }).pipe(
          Effect.flatMap(({ payoutId, outcome, providerRef }) => payouts.report(payoutId, outcome, providerRef)),
          Effect.as(HttpServerResponse.empty({ status: 204 })),
          Effect.catchTag("PayoutProvider.InvalidCallback", ({ reason }) =>
            Effect.succeed(reason === "unauthenticated" ? error(401, "unauthorized") : error(400, "invalid_callback"))),
        )
      })

    return HttpRouter.add("POST", path, handle)
  }),
)

export * as PayoutWebhook from "./payouts.ts"
