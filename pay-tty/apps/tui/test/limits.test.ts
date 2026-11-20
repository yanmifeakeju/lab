import assert from "node:assert/strict"
import { test } from "node:test"

import { EventEmitter } from "node:events"

import { Duration, Effect, Fiber } from "effect"
import * as TestClock from "effect/testing/TestClock"

import { type Activity, type Admission, endWhenIdle, refusalLog, sessionLimit, tooMany } from "../src/limits.ts"

const clock = () => {
  let at = 0

  return { now: () => at, advance: (ms: number) => (at += ms) }
}

const admitted = (admission: Admission) => {
  assert.ok(admission.admitted, "admitted")

  return admission.release
}

void test("an address may hold so many sessions at once, and another once one ends", () => {
  const time = clock()
  const limits = sessionLimit({ concurrent: 3, perMinute: 100, now: time.now })

  const releases = [1, 2, 3].map(() => admitted(limits.admit("203.0.113.7")))

  assert.deepEqual(limits.admit("203.0.113.7"), { admitted: false, reason: tooMany })
  // Another address isn't affected.
  admitted(limits.admit("198.51.100.4"))

  releases[0]?.()
  admitted(limits.admit("203.0.113.7"))
})

void test("an address may start so many sessions a minute, refusals not counted, and more once the minute passes", () => {
  const time = clock()
  const limits = sessionLimit({ concurrent: 100, perMinute: 10, now: time.now })

  for (let started = 0; started < 10; started++) {
    admitted(limits.admit("203.0.113.7"))()
    time.advance(1_000)
  }

  // Refused, and retrying doesn't push the window out.
  assert.equal(limits.admit("203.0.113.7").admitted, false)
  assert.equal(limits.admit("203.0.113.7").admitted, false)

  // The first start was 60 seconds ago: one slot is free again.
  time.advance(50_000)
  admitted(limits.admit("203.0.113.7"))
  assert.equal(limits.admit("203.0.113.7").admitted, false)
})

void test("ending a session twice frees one place, and an idle address is forgotten", () => {
  const time = clock()
  const limits = sessionLimit({ concurrent: 1, perMinute: 100, now: time.now })

  const release = admitted(limits.admit("203.0.113.7"))
  const other = admitted(limits.admit("198.51.100.4"))

  release()
  release()
  admitted(limits.admit("203.0.113.7"))()
  other()

  // A minute on, the next admission sweeps both addresses away.
  time.advance(60_000)
  admitted(limits.admit("192.0.2.1"))()
  assert.equal(limits.tracked(), 1)
})

void test("a withdrawn session gives back its start as well as its place; an ended one keeps the start", () => {
  const time = clock()
  const limits = sessionLimit({ concurrent: 1, perMinute: 2, now: time.now })

  const first = limits.admit("203.0.113.7")

  assert.ok(first.admitted)
  first.withdraw()
  first.withdraw()

  // Both starts are still free.
  admitted(limits.admit("203.0.113.7"))()
  admitted(limits.admit("203.0.113.7"))()

  // Those two ended, so their starts stand: the minute is used up.
  assert.equal(limits.admit("203.0.113.7").admitted, false)
})

void test("a key's refusals are logged once a minute: the first, then the last with how many weren't", () => {
  const time = clock()
  const logged: Array<readonly [string, number, boolean]> = []
  const log = refusalLog<string>((refusal, unlogged, delayed) => logged.push([refusal, unlogged, delayed]), time.now)

  log.refused("203.0.113.7", "first")

  for (let refused = 1; refused <= 500; refused++) {
    log.refused("203.0.113.7", `again ${refused}`)
  }

  // Another key is logged on its own.
  log.refused("198.51.100.4", "other")
  assert.deepEqual(logged, [["first", 0, false], ["other", 0, false]])

  // The burst stops; when its minute is up, its count is still logged.
  time.advance(60_000)
  log.flush()
  assert.deepEqual(logged.slice(2), [["again 500", 499, true]])

  // A new minute starts afresh; refused twice, both are logged and none skipped.
  log.refused("203.0.113.7", "next")
  log.refused("203.0.113.7", "and again")
  assert.deepEqual(logged.at(-1), ["next", 0, false])

  // A shutdown reports what's still counting, whatever its age.
  log.drain()
  assert.deepEqual(logged.at(-1), ["and again", 0, true], "delayed, so it says when")
})

void test("a limit with no per-minute cap only counts open sessions, and keeps no starts", () => {
  const limits = sessionLimit({ concurrent: 2, perMinute: Number.POSITIVE_INFINITY })

  const first = admitted(limits.admit("all"))

  admitted(limits.admit("all"))
  assert.equal(limits.admit("all").admitted, false)

  first()
  admitted(limits.admit("all"))
  assert.equal(limits.tracked(), 1, "only the open count")
})

// Keypresses, pastes and resizes, from an emitter, as the server wires them.
const activityOf = (input: EventEmitter): ReadonlyArray<Activity> =>
  ["keypress", "paste", "resize"].map((event) => (listener: () => void) => {
    input.on(event, listener)

    return () => input.off(event, listener)
  })

const listening = (input: EventEmitter) =>
  ["keypress", "paste", "resize"].reduce((sum, event) => sum + input.listenerCount(event), 0)

void test("a session with no input for its limit is ended; a keypress, paste or resize starts the wait again", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const input = new EventEmitter()
      let ended = 0

      const watching = yield* Effect.forkChild(
        Effect.scoped(endWhenIdle(activityOf(input), Duration.minutes(5), () => (ended += 1))),
      )

      for (const event of ["keypress", "paste", "resize"]) {
        yield* TestClock.adjust(Duration.minutes(4))
        input.emit(event)
      }

      yield* TestClock.adjust(Duration.minutes(4))
      assert.equal(ended, 0, "each kind of input started the wait again")

      yield* TestClock.adjust(Duration.minutes(1))
      yield* Fiber.join(watching)
      assert.equal(ended, 1)
      assert.equal(listening(input), 0, "its listeners are gone with its scope")

      // A session that ends first leaves nothing behind.
      const other = new EventEmitter()

      const early = yield* Effect.forkChild(
        Effect.scoped(endWhenIdle(activityOf(other), Duration.minutes(5), () => (ended += 1))),
      )

      yield* TestClock.adjust(Duration.minutes(1))
      yield* Fiber.interrupt(early)
      yield* TestClock.adjust(Duration.minutes(10))
      assert.deepEqual([ended, listening(other)], [1, 0])
    }).pipe(Effect.provide(TestClock.layer())),
  ))
