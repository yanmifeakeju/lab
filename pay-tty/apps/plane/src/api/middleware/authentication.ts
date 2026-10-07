import { Principal } from "@pay-tty/core/principal"
import { Effect, Layer, Redacted } from "effect"

import { CurrentPrincipal } from "../principal.ts"
import { Token } from "../../token/token.ts"
import { Authentication } from "../routes/middleware.ts"
import { unauthorized } from "../errors.ts"

// A token is only as good as the principal it names: one deleted since issue
// is rejected like a forged token. The stored principal is what handlers see.
export const AuthenticationLive = Layer.effect(Authentication)(
  Effect.gen(function* () {
    const tokens = yield* Token.Service
    const principals = yield* Principal.Service

    return Authentication.of({
      bearer: (httpEffect, { credential }) =>
        Effect.gen(function* () {
          const id = yield* tokens.verify(Redacted.value(credential)).pipe(
            Effect.tapError((error) =>
              Effect.logWarning("access token rejected").pipe(Effect.annotateLogs({ reason: error.reason })),
            ),
            Effect.mapError(() => unauthorized),
          )

          const principal = yield* principals.get(id)

          if (principal === undefined) {
            yield* Effect.logWarning("access token names no principal").pipe(Effect.annotateLogs({ principalId: id }))

            return yield* unauthorized
          }

          return yield* Effect.provideService(httpEffect, CurrentPrincipal.Service, principal)
        }),
    })
  }),
)
