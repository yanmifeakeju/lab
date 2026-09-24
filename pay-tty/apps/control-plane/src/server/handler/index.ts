import { Layer } from "effect"
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder"
import * as HttpApiScalar from "effect/unstable/httpapi/HttpApiScalar"

import { api } from "../api/index.ts"
import { SchemaErrorLive } from "../middleware/schema-error.ts"
import { HealthLive } from "./health.ts"
import { RegisterLive } from "./register.ts"
import { ResolveLive } from "./resolve.ts"

export const ApiLive = Layer.mergeAll(
  HttpApiBuilder.layer(api, { openapiPath: "/openapi.json" }),
  HttpApiScalar.layer(api),
).pipe(
  Layer.provide(Layer.mergeAll(HealthLive, ResolveLive, RegisterLive)),
  Layer.provide(SchemaErrorLive),
)
