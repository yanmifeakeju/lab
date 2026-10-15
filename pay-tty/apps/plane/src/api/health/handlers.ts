import { Effect } from "effect"
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder"

import { api } from "../api.ts"
import { Health } from "./routes.ts"

export const HealthLive = HttpApiBuilder.group(api, "health", (handlers) =>
  handlers.handle("getHealth", () => Effect.succeed(new Health({ status: "ok" }))),
)
