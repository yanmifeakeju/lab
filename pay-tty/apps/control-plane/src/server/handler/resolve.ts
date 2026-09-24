import { Effect } from "effect"
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder"

import { api } from "../api/index.ts"
import { CurrentPrincipal } from "../../core/principal/current.ts"
import { Session } from "../../core/session/session.ts"

export const ResolveLive = HttpApiBuilder.group(api, "resolve", (handlers) =>
  handlers.handle("resolve", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const principal = yield* CurrentPrincipal.Service

      return yield* session.resolve(principal)
    }),
  ),
)
