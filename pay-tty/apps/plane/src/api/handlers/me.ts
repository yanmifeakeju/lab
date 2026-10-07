import { Business } from "@pay-tty/core/business"
import { Effect } from "effect"
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder"

import { CurrentPrincipal } from "../principal.ts"
import { businessInfo } from "../routes/business.ts"
import { api } from "../routes/index.ts"
import { MeResponse } from "../routes/me.ts"

// A read: it never creates a business or opens its ledger.
export const MeLive = HttpApiBuilder.group(api, "me", (handlers) =>
  handlers.handle("me", () =>
    Effect.gen(function* () {
      const businesses = yield* Business.Service
      const principal = yield* CurrentPrincipal.Service

      const business = yield* businesses.findByPrincipal(principal.id)

      return new MeResponse({
        id: principal.id,
        created_at: principal.createdAt.toISOString(),
        business: business === undefined ? null : businessInfo(business),
      })
    }),
  ),
)
