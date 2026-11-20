import { Duration, Effect, Option, Queue } from "effect"

// Anyone can make a new SSH key, so the key limits keep one person to a fair
// share and the address limits are what stop abuse. An address allows an
// office of 50, a session each, and filling the server takes
// `sessionsInAll / openPerAddress` addresses, 7. A session's memory grows with
// its terminal: about 0.7 MB at 80x24 and 6.3 MB at the 500x200 a client may
// ask for, measured with 40 open. At that worst case 350 sessions take about
// 2.2 GB, under a third of the 8 GB box; the TUI runs on one core.

/** Sessions one SSH key may have open at once. */
export const openPerKey = 3

/** Sessions one SSH key may start in any minute. */
export const startsPerKey = 10

/** Sessions one client address may have open at once. */
export const openPerAddress = 50

/** Sessions one client address may start in any minute. */
export const startsPerAddress = 60

/** Sessions across the server, refused with a reason by server.tsx; @opentui/ssh's own cap is twice this. */
export const sessionsInAll = 350

/**
 * How long a session may go without input, by who it is. A merchant's outlasts
 * a payout's follow (5 minutes, session.ts), which outlasts plane's provider
 * checks at 2 and 4 minutes, so one watching a slow payout sees it settle; a
 * customer's outlasts plane's 30-minute payment window, so the countdown
 * they're shown is kept.
 */
export const idleFor = { merchant: Duration.minutes(10), customer: Duration.minutes(31) } as const

/** @opentui/ssh's own idle limit, a backstop above every `idleFor`. */
export const idleTimeout = "35m"

/** Subscribes `listener` to one kind of input, and returns how to unsubscribe. */
export type Activity = (listener: () => void) => () => void

/**
 * Calls `end` once `limit` passes with none of `activity` (keypresses, pastes,
 * resizes). Lasts as long as its scope, so fork it into the session's.
 */
export const endWhenIdle = (activity: ReadonlyArray<Activity>, limit: Duration.Duration, end: () => void) =>
  Effect.gen(function* () {
    const pressed = yield* Queue.sliding<void>(1)
    const listener = () => void Queue.offerUnsafe(pressed, undefined)

    for (const subscribe of activity) {
      yield* Effect.acquireRelease(Effect.sync(() => subscribe(listener)), (unsubscribe) => Effect.sync(unsubscribe))
    }

    for (;;) {
      if (Option.isNone(yield* Effect.timeoutOption(Queue.take(pressed), limit))) {
        end()

        return
      }
    }
  })

const minute = 60_000

// Only moves forwards, so a clock set back can't keep anyone refused.
const monotonic = () => performance.now()

/** Why a session was refused, as the client sees it. */
export const tooMany = "Too many sessions. Try again in a minute."

export type Admission =
  | {
    readonly admitted: true
    /** The session ended: frees its place. Its start still counts for the minute. */
    readonly release: () => void
    /** The session never began after all: frees its place and its start. */
    readonly withdraw: () => void
  }
  | { readonly admitted: false; readonly reason: string }

/** How often every key's starts are swept, at most. */
const sweepEvery = 1_000

/**
 * Counts sessions by a key such as a client address or an SSH key: at most
 * `concurrent` open at once, and `perMinute` started in any 60 seconds. A
 * refused or withdrawn session counts toward neither, so retrying once the
 * window frees up works. Nothing is kept for a key with no open sessions and
 * no recent starts.
 */
export const sessionLimit = (options: {
  readonly concurrent: number
  readonly perMinute: number
  readonly now?: () => number
}) => {
  const now = options.now ?? monotonic
  const open = new Map<string, number>()
  const starts = new Map<string, Array<number>>()
  let swept = Number.NEGATIVE_INFINITY

  const recent = (key: string, at: number) => {
    const kept = (starts.get(key) ?? []).filter((started) => at - started < minute)

    if (kept.length === 0) {
      starts.delete(key)
    } else {
      starts.set(key, kept)
    }

    return kept
  }

  const close = (key: string) => {
    const left = (open.get(key) ?? 1) - 1

    if (left <= 0) {
      open.delete(key)
    } else {
      open.set(key, left)
    }
  }

  const admit = (key: string): Admission => {
    const at = now()

    // Every key now and then, so one that never comes back is forgotten,
    // without walking them all on each admission.
    if (at - swept >= sweepEvery) {
      swept = at

      for (const known of starts.keys()) {
        recent(known, at)
      }
    }

    const started = recent(key, at)
    const live = open.get(key) ?? 0

    if (live >= options.concurrent || started.length >= options.perMinute) {
      return { admitted: false, reason: tooMany }
    }

    open.set(key, live + 1)

    // Without a per-minute limit, starts are never read: don't keep them.
    if (Number.isFinite(options.perMinute)) {
      starts.set(key, [...started, at])
    }

    let done = false

    const finish = (start: "kept" | "dropped") => {
      if (done) {
        return
      }

      done = true
      close(key)

      if (start === "dropped") {
        const list = starts.get(key) ?? []
        const index = list.indexOf(at)

        if (index !== -1) {
          list.splice(index, 1)
        }
      }

      recent(key, now())
    }

    return { admitted: true, release: () => finish("kept"), withdraw: () => finish("dropped") }
  }

  /** Keys with anything counted, for tests. */
  const tracked = () => new Set([...open.keys(), ...starts.keys()]).size

  return { admit, tracked }
}

/**
 * Logs refusals at most once a minute per key: the first is logged with
 * `unlogged` 0, the rest are counted, and when the key's minute is up the last
 * of them is logged, `delayed`, with how many before it weren't. A refused session costs a
 * client one round trip, and one connection can be refused over and over, so
 * logging each would flush the log of anything else. `flush` reports keys whose
 * minute is up; call it now and then, so a burst that stops is still counted.
 * `drain` reports them all, for a shutdown.
 */
export const refusalLog = <A>(
  log: (refusal: A, unlogged: number, delayed: boolean) => void,
  now: () => number = monotonic,
) => {
  const last = new Map<string, { readonly at: number; skipped: number; latest: A }>()
  let flushed = Number.NEGATIVE_INFINITY

  const report = (whole: boolean) => {
    const at = now()

    for (const [key, entry] of last) {
      if (whole || at - entry.at >= minute) {
        last.delete(key)

        // The latest is logged; the ones between it and the first aren't.
        if (entry.skipped > 0) {
          log(entry.latest, entry.skipped - 1, true)
        }
      }
    }
  }

  const flush = () => report(false)

  const drain = () => report(true)

  const refused = (key: string, refusal: A) => {
    if (now() - flushed >= sweepEvery) {
      flushed = now()
      flush()
    }

    const entry = last.get(key)

    if (entry === undefined) {
      last.set(key, { at: now(), skipped: 0, latest: refusal })
      log(refusal, 0, false)

      return
    }

    entry.skipped += 1
    entry.latest = refusal
  }

  return { refused, flush, drain }
}
