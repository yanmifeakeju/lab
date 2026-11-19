import { Business } from "@pay-tty/core/business"
import { Payments } from "@pay-tty/core/payments"
import { Duration, Effect, Option } from "effect"
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder"

import { CurrentPrincipal } from "../principal.ts"
import { api } from "../api.ts"
import { businessInfo } from "../business/routes.ts"
import { MeResponse } from "./routes.ts"

// A read: it never creates a business or opens its ledger.
export const MeLive = HttpApiBuilder.group(api, "me", (handlers) =>
  handlers.handle("me", () =>
    Effect.gen(function* () {
      const businesses = yield* Business.Service
      const principal = yield* CurrentPrincipal.Service
      const payments = yield* Payments.Service

      const business = yield* businesses.findByPrincipal(principal.id)

      return new MeResponse({
        id: principal.id,
        created_at: principal.createdAt.toISOString(),
        business: business === undefined ? null : businessInfo(business),
        settlement_delay_seconds: Option.getOrNull(
          Option.map(payments.settlementDelay, (delay) => Math.round(Duration.toSeconds(delay))),
        ),
      })
    }),
  ),
)
