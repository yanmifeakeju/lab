import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint"
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup"

import { Session } from "../../core/session/session.ts"

export const resolve = HttpApiGroup.make("resolve").add(
  HttpApiEndpoint.get("resolve", "/v1/resolve", { success: Session.Resolution }),
)
