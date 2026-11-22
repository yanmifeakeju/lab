import { createServer } from "@opentui/ssh"
import { Config, ConfigProvider, DateTime, Effect, Layer, Logger, ManagedRuntime, Option, Schedule } from "effect"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"

import { connect, pay } from "../src/connection.tsx"
import {
  type Activity,
  endWhenIdle,
  idleFor,
  idleTimeout,
  refusalLog,
  openPerAddress,
  openPerKey,
  sessionLimit,
  sessionsInAll,
  startsPerAddress,
  startsPerKey,
} from "../src/limits.ts"
import { payCommand } from "../src/pay-command.ts"
import { Plane } from "../src/plane.ts"

// Every setting is read from the environment as TUI_<name>.
const ConfigLive = ConfigProvider.layer(ConfigProvider.nested(ConfigProvider.fromEnv(), "TUI"))

// One line per event, fields as key=value: `timestamp=… level=INFO message="session started" address=203.0.113.7 …`.
const LoggerLive = Logger.layer([Logger.consoleLogFmt])

const runtime = ManagedRuntime.make(
  Plane.layer.pipe(Layer.provide(FetchHttpClient.layer), Layer.provideMerge(ConfigLive), Layer.provideMerge(LoggerLive)),
)

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

// The port is public and any key is accepted, so each address and each key is
// limited before a session starts anything in plane.
const byAddress = sessionLimit({ concurrent: openPerAddress, perMinute: startsPerAddress })

const byKey = sessionLimit({ concurrent: openPerKey, perMinute: startsPerKey })

// Counted here, not only by @opentui/ssh, so a full server refuses with a
// reason and a log line; the library's own cap, twice this, is the backstop.
const inAll = sessionLimit({ concurrent: sessionsInAll, perMinute: Number.POSITIVE_INFINITY })

interface SessionFields {
  readonly address: string
  readonly as: "customer" | "merchant"
  // A merchant's only: a customer's key is counted but not logged.
  readonly fingerprint?: string
  // Refusals for the same limit since the last one logged, and when the last
  // of them was: a summary is written about a minute after the first.
  readonly unlogged?: number
  readonly last_at?: string
}

// A summary of refusals from many clients, as when the server is full: it names
// none of them, so no one client takes the blame for the count.
interface PooledFields {
  readonly address: "*"
  readonly unlogged: number
  readonly last_at: string
}

// Set once stop() begins, after which the runtime may be gone.
let stopping = false

// Fields as annotations, so logfmt writes them as key=value, not one JSON blob.
// A session ending during shutdown may log after the runtime is disposed; that
// line is dropped. Any other logging failure is reported, in the same format.
const log = (message: string, fields: SessionFields | PooledFields) =>
  void runtime.runPromise(Effect.logInfo(message).pipe(Effect.annotateLogs({ ...fields }))).catch((error: Error) => {
    if (!stopping) {
      Effect.runFork(
        Effect.logError("session log failed", error).pipe(Effect.annotateLogs({ ...fields }), Effect.provide(LoggerLive)),
      )
    }
  })

// A refusal is logged at most once a minute for the same limit and key; the
// minute's last carries how many weren't.
// A delayed summary says when its last refusal was, since it's written later.
const refusals = refusalLog<{
  readonly message: string
  readonly fields: SessionFields
  readonly pooled: boolean
  readonly at: DateTime.Utc
}>(({ message, fields, pooled, at }, unlogged, delayed) => {
  if (!delayed) {
    return log(message, fields)
  }

  const last_at = DateTime.formatIso(at)

  log(message, pooled ? { address: "*", unlogged, last_at } : { ...fields, unlogged, last_at })
})

// `key` "all" pools every client's refusals under one count.
const refused = (message: string, key: string, fields: SessionFields) =>
  refusals.refused(`${message}\n${key}`, { message, fields, pooled: key === "all", at: DateTime.nowUnsafe() })

// So a burst that stops is still counted when its minute is up.
runtime.runFork(Effect.repeat(Effect.sync(refusals.flush), Schedule.spaced("10 seconds")))

// Any key is accepted. A merchant's key is their identity, and plane makes a
// principal for one it hasn't seen; a customer's key is only counted, in
// memory, against the per-key limits, never logged or sent to plane.
const server = createServer({
  hostKey: { path: config.hostKey },
  auth: { publicKey: "any" },
  idleTimeout,
  // Twice ours: every session, refused ones too, holds a library place until
  // its connection drains (up to a second), so a burst of refusals mustn't
  // fill it before ours refuses with a reason.
  limits: { session: { global: sessionsInAll * 2 } },
  // Our own "listening" line says the same, in the log's format.
  startupBanner: false,
  // ssh2 tags a connection's own failures with a level: those are clients that
  // can't speak SSH to us, mostly scanners, so one line each, without a stack.
  onError: (error) => {
    const failed = error instanceof Error && "level" in error

    const report = failed
      ? Effect.logWarning("connection failed").pipe(Effect.annotateLogs({ stage: String(error.level), reason: error.message }))
      : Effect.logError("ssh error", error)

    void runtime.runPromise(report).catch(() => {})
  },
}).use((session, next) => {
  // A customer's user name is a share token, which isn't logged either.
  const customer = shareToken.test(session.identity.username)

  const fields: SessionFields = customer
    ? { address: session.remoteAddress.address, as: "customer" }
    : { address: session.remoteAddress.address, as: "merchant", fingerprint: session.identity.fingerprint }

  // Address and key first, so a flooder is refused, and logged, as itself
  // before a full server would refuse everyone alike.
  const address = byAddress.admit(fields.address)

  if (!address.admitted) {
    refused("session refused: too many from this address", fields.address, fields)

    return session.deny(address.reason)
  }

  const key = byKey.admit(session.identity.fingerprint)

  // A session refused here never began: what admitted it gets its place back.
  if (!key.admitted) {
    address.withdraw()
    refused("session refused: too many for this key", session.identity.fingerprint, fields)

    return session.deny(key.reason)
  }

  const whole = inAll.admit("all")

  if (!whole.admitted) {
    key.withdraw()
    address.withdraw()
    refused("session refused: the server is full", "all", fields)

    return session.deny(whole.reason)
  }

  log("session started", fields)

  // Handed to the session, so everything it logs says whose it is.
  return next({ fields }).finally(() => {
    key.release()
    address.release()
    whole.release()
    log("session ended", fields)
  })
}).serve((connection) => {
  // With the mouse reported to us, a drag selects nothing in the client's
  // terminal, so Cmd+C has nothing to copy and Ctrl+Shift+C arrives as Ctrl+C.
  connection.renderer.useMouse = false

  const onClose = (callback: () => void) => connection.onClose(callback)
  const end = () => connection.end()

  const session = shareToken.test(connection.identity.username)
    ? pay(connection.identity.username, connection.renderer, onClose, end)
    : connect(connection.identity.fingerprint, connection.renderer, onClose, end, commandFor)

  const { fields } = connection.context
  const keys = connection.renderer.keyInput

  // Keypresses, pastes and resizes all count as the session being used.
  const activity: ReadonlyArray<Activity> = [
    (listener) => {
      keys.on("keypress", listener)

      return () => keys.off("keypress", listener)
    },
    (listener) => {
      keys.on("paste", listener)

      return () => keys.off("paste", listener)
    },
    (listener) => connection.onResize(listener),
  ]

  // Its own idle limit, by who it is; @opentui/ssh's is only a backstop.
  const idle = endWhenIdle(activity, idleFor[fields.as], () => {
    log("session idle", fields)
    end()
  })

  return runtime.runPromise(
    Effect.scoped(Effect.andThen(Effect.forkScoped(idle), session)).pipe(Effect.annotateLogs({ ...fields })),
  )
})

const { host, port, fingerprints } = await server.listen(config.port, config.host)

await runtime.runPromise(
  Effect.logInfo("listening").pipe(Effect.annotateLogs({ host, port, fingerprints: fingerprints.join(",") })),
)

// Closing the server destroys each renderer first, which turns the client
// terminal's mouse reporting and alternate screen back off. A process that
// just exits leaves them on, and the client's shell echoes every mouse move.
// A second signal stops at once.

const stop = (signal: NodeJS.Signals) => {
  if (stopping) {
    process.exit(1)
  }

  stopping = true

  // Refusals still being counted are logged before the process goes.
  refusals.drain()

  void runtime
    .runPromise(Effect.logInfo("stopping").pipe(Effect.annotateLogs({ signal })))
    .then(() => server.close())
    .then(() => runtime.dispose())
    .finally(() => process.exit(0))
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, stop)
}
