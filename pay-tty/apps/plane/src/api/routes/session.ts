import { Schema } from "effect"
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint"
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup"

import { Forbidden } from "../errors.ts"

// The gateway's assertion of who connected. It is not proof: the gateway
// verified the SSH key, and only trusted gateways can reach this route.
export class SessionRequest extends Schema.Class<SessionRequest>("SessionRequest")({
  issuer: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  sub: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(255),
    Schema.isPattern(new RegExp(".*\\S.*")).annotate({ expected: "a string containing non-whitespace" }),
  ),
}) {}

export class SessionResponse extends Schema.Class<SessionResponse>("SessionResponse")({
  accessToken: Schema.String,
  tokenType: Schema.Literal("Bearer"),
  expiresIn: Schema.Int,
}) {}

export const session = HttpApiGroup.make("session").add(
  HttpApiEndpoint.post("createSession", "/session", {
    payload: SessionRequest,
    success: SessionResponse,
    error: Forbidden,
  }),
)
