// The Effect HTTP server binds a Node server; the suggested HttpClient is the client side.
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { createServer } from "node:http"

import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Config, Layer } from "effect"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as HttpRouter from "effect/unstable/http/HttpRouter"

import { layer as SimDatabaseLayer } from "../src/database.ts"
import { routes } from "../src/http/routes.ts"
import { Reporter } from "../src/payouts/reporter.ts"
import { keys } from "../src/signature.ts"

// The simulated payout provider: its API for plane, and its callbacks to plane.
const Sim = HttpRouter.serve(routes).pipe(
  Layer.merge(Reporter.layer),
  Layer.merge(Layer.effectDiscard(keys)),
  Layer.provide(NodeHttpServer.layerConfig(createServer, { port: Config.Port("PORT").pipe(Config.withDefault(4000)) })),
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(SimDatabaseLayer),
)

NodeRuntime.runMain(Layer.launch(Sim))
