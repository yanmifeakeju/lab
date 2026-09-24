import { Effect } from "effect"
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder"

import { Health } from "../api/health.ts"
import { api } from "../api/index.ts"

export const HealthLive = HttpApiBuilder.group(api, "health", (handlers) =>
  handlers.handle("getHealth", () => Effect.succeed(new Health({ status: "ok" }))),
)
