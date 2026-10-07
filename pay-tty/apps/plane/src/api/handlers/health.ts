import { Effect } from "effect"
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder"

import { Health } from "../routes/health.ts"
import { api } from "../routes/index.ts"

export const HealthLive = HttpApiBuilder.group(api, "health", (handlers) =>
  handlers.handle("getHealth", () => Effect.succeed(new Health({ status: "ok" }))),
)
