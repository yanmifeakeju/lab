import { createServer } from "@opentui/ssh"
import { Config, ConfigProvider, Effect, Layer, ManagedRuntime, Option } from "effect"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"

import { connect, pay } from "../src/connection.tsx"
import { payCommand } from "../src/pay-command.ts"
import { Plane } from "../src/plane.ts"

// Every setting is read from the environment as TUI_<name>.
const ConfigLive = ConfigProvider.layer(ConfigProvider.nested(ConfigProvider.fromEnv(), "TUI"))

const runtime = ManagedRuntime.make(Plane.layer.pipe(Layer.provide(FetchHttpClient.layer), Layer.provideMerge(ConfigLive)))

const config = await runtime.runPromise(
  Config.all({
    host: Config.String("HOST").pipe(Config.withDefault("127.0.0.1")),
    port: Config.Port("PORT").pipe(Config.withDefault(2222)),
    hostKey: Config.String("HOST_KEY_PATH").pipe(Config.withDefault(".data/host_key")),
    publicHost: Config.String("PUBLIC_HOST").pipe(Config.withDefault("localhost")),
    publicPort: Config.Port("PUBLIC_PORT").pipe(Config.option),
  }),
)

// What a merchant shares for a link.
const commandFor = payCommand(config.publicHost, Option.getOrElse(config.publicPort, () => config.port))

// A share token as the user name: `ssh <token>@host` pays that link.
const shareToken = /^[A-Za-z0-9_][A-Za-z0-9_-]{42}$/

// Any key is accepted. A merchant's key is their identity, and plane makes a
// principal for one it hasn't seen; a customer's key is never looked at.
const server = createServer({ hostKey: { path: config.hostKey }, auth: { publicKey: "any" } }).serve((connection) => {
  // With the mouse reported to us, a drag selects nothing in the client's
  // terminal, so Cmd+C has nothing to copy and Ctrl+Shift+C arrives as Ctrl+C.
  connection.renderer.useMouse = false

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

// Closing the server destroys each renderer first, which turns the client
// terminal's mouse reporting and alternate screen back off. A process that
// just exits leaves them on, and the client's shell echoes every mouse move.
// A second signal stops at once.
let stopping = false

const stop = (signal: NodeJS.Signals) => {
  if (stopping) {
    process.exit(1)
  }

  stopping = true

  void runtime
    .runPromise(Effect.logInfo("stopping", { signal }))
    .then(() => server.close())
    .then(() => runtime.dispose())
    .finally(() => process.exit(0))
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, stop)
}
