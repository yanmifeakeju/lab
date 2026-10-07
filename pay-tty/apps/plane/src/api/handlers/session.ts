import { Principal } from "@pay-tty/core/principal"
import { Effect, Redacted } from "effect"
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder"

import { Token } from "../../token/token.ts"
import { Forbidden } from "../errors.ts"
import { api } from "../routes/index.ts"
import { SessionResponse } from "../routes/session.ts"

// The identity issuers a gateway may assert.
const issuers = new Set(["ssh"])

// Finds or creates the principal and issues its token; nothing else. Clients
// read the principal and its business from /me.
export const SessionLive = HttpApiBuilder.group(api, "session", (handlers) =>
  handlers.handle("createSession", ({ payload }) =>
    Effect.gen(function* () {
      if (!issuers.has(payload.issuer)) {
        return yield* new Forbidden({
          message: "This identity issuer is not accepted.",
          error: { code: "forbidden" },
        })
      }

      const principals = yield* Principal.Service
      const tokens = yield* Token.Service

      const principal = yield* principals.ensure({ issuer: payload.issuer, subject: payload.sub })
      const issued = yield* tokens.issue(principal.id)

      return new SessionResponse({
        accessToken: Redacted.value(issued.accessToken),
        tokenType: "Bearer",
        expiresIn: issued.expiresIn,
      })
    }),
  ),
)
