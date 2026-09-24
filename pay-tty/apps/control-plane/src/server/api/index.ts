import * as HttpApi from "effect/unstable/httpapi/HttpApi"
import * as OpenApi from "effect/unstable/httpapi/OpenApi"

import { SchemaErrorMiddleware } from "./errors.ts"
import { health } from "./health.ts"
import { register } from "./register.ts"
import { resolve } from "./resolve.ts"

export const api = HttpApi.make("control-plane")
  .add(health)
  .add(resolve)
  .add(register)
  .middleware(SchemaErrorMiddleware)
  .annotate(OpenApi.Title, "Control plane")
  // Report every failing field rather than the first, like the ledger API.
  // Unknown fields are dropped, not rejected: these options also apply when
  // encoding responses, where "error" would reject the error class's own
  // runtime properties.
  .annotate(HttpApi.ParseOptions, { errors: "all" })
