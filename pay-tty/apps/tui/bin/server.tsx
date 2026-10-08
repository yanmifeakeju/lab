import { createServer } from "@opentui/ssh"
import { Config, Effect, Layer, ManagedRuntime } from "effect"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"

import { connect } from "../src/connection.tsx"
import { Plane } from "../src/plane.ts"

const runtime = ManagedRuntime.make(Plane.layer.pipe(Layer.provide(FetchHttpClient.layer)))

const config = await runtime.runPromise(
  Config.all({
    host: Config.String("TUI_HOST").pipe(Config.withDefault("127.0.0.1")),
    port: Config.Port("TUI_PORT").pipe(Config.withDefault(2222)),
    hostKey: Config.String("TUI_HOST_KEY_PATH").pipe(Config.withDefault(".data/host_key")),
  }),
)

// Any key is accepted: it is the caller's identity, and plane makes a
// principal for one it hasn't seen.
const server = createServer({ hostKey: { path: config.hostKey }, auth: { publicKey: "any" } }).serve((connection) =>
  runtime.runPromise(
    connect(
      connection.identity.fingerprint,
      connection.renderer,
      (callback) => connection.onClose(callback),
      () => connection.end(),
    ),
  ),
)

const { host, port, fingerprints } = await server.listen(config.port, config.host)

await runtime.runPromise(Effect.logInfo("listening", { host, port, fingerprints }))
