import { Principal } from "@pay-tty/core/principal"
import { Effect, Layer, Redacted } from "effect"
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware"
import * as HttpApiSecurity from "effect/unstable/httpapi/HttpApiSecurity"

import { Token } from "../../token/token.ts"
import { Unauthorized, unauthorized } from "../errors.ts"
import { CurrentPrincipal } from "../principal.ts"

// Verifies the caller's bearer token and provides the principal it names to
// the handler, one request at a time.
export class Authentication extends HttpApiMiddleware.Service<
  Authentication,
  { provides: CurrentPrincipal.Service }
>()("Authentication", {
  error: Unauthorized,
  security: { bearer: HttpApiSecurity.bearer },
}) {}

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
