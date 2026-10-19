import { createServer } from "@opentui/ssh"
import { Config, Effect, Layer, ManagedRuntime, Option } from "effect"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"

import { connect, pay } from "../src/connection.tsx"
import { payCommand } from "../src/pay-command.ts"
import { Plane } from "../src/plane.ts"

const runtime = ManagedRuntime.make(Plane.layer.pipe(Layer.provide(FetchHttpClient.layer)))

const config = await runtime.runPromise(
  Config.all({
    host: Config.String("TUI_HOST").pipe(Config.withDefault("127.0.0.1")),
    port: Config.Port("TUI_PORT").pipe(Config.withDefault(2222)),
    hostKey: Config.String("TUI_HOST_KEY_PATH").pipe(Config.withDefault(".data/host_key")),
    publicHost: Config.String("TUI_PUBLIC_HOST").pipe(Config.withDefault("localhost")),
    publicPort: Config.Port("TUI_PUBLIC_PORT").pipe(Config.option),
  }),
)

// What a merchant shares for a link.
const commandFor = payCommand(config.publicHost, Option.getOrElse(config.publicPort, () => config.port))

// A share token as the user name: `ssh <token>@host` pays that link.
const shareToken = /^[A-Za-z0-9_][A-Za-z0-9_-]{42}$/

// Any key is accepted. A merchant's key is their identity, and plane makes a
// principal for one it hasn't seen; a customer's key is never looked at.
const server = createServer({ hostKey: { path: config.hostKey }, auth: { publicKey: "any" } }).serve((connection) => {
  const onClose = (callback: () => void) => connection.onClose(callback)
  const end = () => connection.end()

  return runtime.runPromise(
    shareToken.test(connection.identity.username)
      ? pay(connection.identity.username, connection.renderer, onClose, end)
      : connect(connection.identity.fingerprint, connection.renderer, onClose, end, commandFor),
  )
})

const { host, port, fingerprints } = await server.listen(config.port, config.host)

await runtime.runPromise(Effect.logInfo("listening", { host, port, fingerprints }))
