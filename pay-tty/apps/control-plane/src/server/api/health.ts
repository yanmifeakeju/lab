import { Schema } from "effect"
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint"
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup"

export class Health extends Schema.Class<Health>("Health")({
  status: Schema.Literal("ok"),
}) {}

export const health = HttpApiGroup.make("health").add(
  HttpApiEndpoint.get("getHealth", "/health", { success: Health }),
)
