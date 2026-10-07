import { Schema } from "effect"
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint"
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup"

import { Authentication } from "./middleware.ts"
import { BusinessInfo } from "./business.ts"

export class MeResponse extends Schema.Class<MeResponse>("MeResponse")({
  id: Schema.String,
  created_at: Schema.String,
  // Null only when no business is linked, whatever the linked one's status.
  business: Schema.NullOr(BusinessInfo),
}) {}

export const me = HttpApiGroup.make("me").add(
  HttpApiEndpoint.get("me", "/me", { success: MeResponse }),
).middleware(Authentication)
