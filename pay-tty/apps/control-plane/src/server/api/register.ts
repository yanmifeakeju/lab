import { Schema } from "effect"
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint"
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup"

import { Session } from "../../core/session/session.ts"

export class RegisterRequest extends Schema.Class<RegisterRequest>("RegisterRequest")({
  name: Schema.String.check(
    Schema.isMinLength(1).annotate({ expected: "a value with a length of at least 1" }),
    Schema.isMaxLength(255).annotate({ expected: "a value with a length of at most 255" }),
    Schema.isPattern(new RegExp(".*\\S.*")).annotate({
      expected: "a string containing non-whitespace",
    }),
  ),
}) {}

export const register = HttpApiGroup.make("register").add(
  HttpApiEndpoint.post("register", "/v1/register", {
    payload: RegisterRequest,
    success: Session.Resolution,
  }),
)
