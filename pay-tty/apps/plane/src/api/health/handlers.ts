import { Clock, Duration, Effect } from "effect"
import * as HttpMiddleware from "effect/unstable/http/HttpMiddleware"
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder"

import { api } from "../api.ts"
import { Health } from "./routes.ts"

// Docker's health check asks every few seconds; one line in five minutes
// shows it still does.
const logEvery = Duration.toMillis(Duration.minutes(5))

export const HealthLive = HttpApiBuilder.group(api, "health", (handlers) => {
  let logged = Number.NEGATIVE_INFINITY

  return handlers.handle("getHealth", () =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const health = Effect.succeed(new Health({ status: "ok" }))

      if (now - logged < logEvery) return yield* HttpMiddleware.withLoggerDisabled(health)

      logged = now

      return yield* health
    }),
  )
})
