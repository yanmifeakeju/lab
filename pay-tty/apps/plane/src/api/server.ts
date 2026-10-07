// The Effect HTTP server binds a Node server; the suggested HttpClient is the client side.
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { createServer } from "node:http"

import { NodeHttpServer } from "@effect/platform-node"
import { Config, Layer } from "effect"
import * as HttpRouter from "effect/unstable/http/HttpRouter"

import { ApiLive } from "./handlers/index.ts"
import { UnknownErrorResponse } from "./middleware/defect.ts"

const ServerLive = NodeHttpServer.layerConfig(createServer, {
  port: Config.Port("PORT").pipe(Config.withDefault(3000)),
})

export const Plane = HttpRouter.serve(
  Layer.mergeAll(ApiLive, UnknownErrorResponse),
).pipe(Layer.provide(ServerLive))
