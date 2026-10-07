import { Layer } from "effect"
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder"
import * as HttpApiScalar from "effect/unstable/httpapi/HttpApiScalar"

import { api } from "../routes/index.ts"
import { SchemaErrorLive } from "../middleware/schema-error.ts"
import { BusinessLive } from "./business.ts"
import { HealthLive } from "./health.ts"
import { MeLive } from "./me.ts"
import { SessionLive } from "./session.ts"

export const ApiLive = Layer.mergeAll(
  HttpApiBuilder.layer(api, { openapiPath: "/openapi.json" }),
  HttpApiScalar.layer(api),
).pipe(
  Layer.provide(Layer.mergeAll(HealthLive, SessionLive, MeLive, BusinessLive)),
  Layer.provide(SchemaErrorLive),
)
