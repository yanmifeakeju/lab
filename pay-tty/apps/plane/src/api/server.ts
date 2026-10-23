// The Effect HTTP server binds a Node server; the suggested HttpClient is the client side.
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { createServer } from "node:http"

import { NodeHttpServer } from "@effect/platform-node"
import { Config, Layer } from "effect"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder"
import * as HttpApiScalar from "effect/unstable/httpapi/HttpApiScalar"

import { api } from "./api.ts"
import { AccountLive } from "./account/handlers.ts"
import { BusinessLive } from "./business/handlers.ts"
import { HealthLive } from "./health/handlers.ts"
import { MeLive } from "./me/handlers.ts"
import { BusinessContextLive } from "./middleware/business.ts"
import { UnknownErrorResponse } from "./middleware/defect.ts"
import { SchemaErrorLive } from "./middleware/schema-error.ts"
import { PayLive } from "./pay/handlers.ts"
import { PaymentsLive } from "./payments/handlers.ts"
import { PaymentLinksLive } from "./payment_links/handlers.ts"
import { SessionLive } from "./session/handlers.ts"

export const ApiLive = Layer.mergeAll(
  HttpApiBuilder.layer(api, { openapiPath: "/openapi.json" }),
  HttpApiScalar.layer(api),
).pipe(
  Layer.provide(Layer.mergeAll(HealthLive, SessionLive, MeLive, BusinessLive, AccountLive, PaymentLinksLive, PaymentsLive, PayLive)),
  Layer.provide(Layer.mergeAll(SchemaErrorLive, BusinessContextLive)),
)

const ServerLive = NodeHttpServer.layerConfig(createServer, {
  port: Config.Port("PORT").pipe(Config.withDefault(3000)),
})

export const Plane = HttpRouter.serve(
  Layer.mergeAll(ApiLive, UnknownErrorResponse),
).pipe(Layer.provide(ServerLive))
