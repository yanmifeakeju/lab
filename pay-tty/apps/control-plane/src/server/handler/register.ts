import { Effect } from "effect"
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder"

import { api } from "../api/index.ts"
import { Business } from "../../core/business/business.ts"
import { CurrentPrincipal } from "../../core/principal/current.ts"
import { Provisioning } from "../../core/provisioning/provisioning.ts"
import { Session } from "../../core/session/session.ts"

export const RegisterLive = HttpApiBuilder.group(api, "register", (handlers) =>
  handlers.handle("register", ({ payload }) =>
    Effect.gen(function* () {
      const provisioning = yield* Provisioning.Service
      const session = yield* Session.Service
      const principal = yield* CurrentPrincipal.Service

      yield* provisioning.register(
        principal,
        new Business.Details({ name: payload.name }),
      )

      return yield* session.resolve(principal)
    }),
  ),
)
