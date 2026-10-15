import { Business } from "@pay-tty/core/business"
import { Context, Effect, Layer } from "effect"
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware"

import { businessRequired, Conflict } from "../errors.ts"
import { CurrentPrincipal } from "../principal.ts"

// The caller's business, as stored when the request began. A principal has at
// most one, so the token names it and no route carries its ID.
export class CurrentBusiness extends Context.Service<CurrentBusiness, Business.Info>()("CurrentBusiness") {}

// Declared after Authentication on a group, so it runs inside it.
export class BusinessContext extends HttpApiMiddleware.Service<
  BusinessContext,
  { provides: CurrentBusiness; requires: CurrentPrincipal.Service }
>()("BusinessContext", { error: Conflict }) {}

export const BusinessContextLive = Layer.effect(BusinessContext)(
  Effect.gen(function* () {
    const businesses = yield* Business.Service

    return BusinessContext.of((httpEffect) =>
      Effect.gen(function* () {
        const principal = yield* CurrentPrincipal.Service
        const business = yield* businesses.findByPrincipal(principal.id)

        if (business === undefined) {
          return yield* businessRequired
        }

        return yield* Effect.provideService(httpEffect, CurrentBusiness, business)
      }),
    )
  }),
)
