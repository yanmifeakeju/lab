import assert from "node:assert/strict"
import { test } from "node:test"

import { Duration, Effect, Redacted } from "effect"
import * as TestClock from "effect/testing/TestClock"

import { Signature } from "../src/signature.ts"

const secret = Redacted.make("shared-secret")

const run = <A>(effect: Effect.Effect<A>) => Effect.runPromise(effect.pipe(Effect.provide(TestClock.layer())))

void test("a callback signature verifies only for its own secret and body, with every header, and only while fresh", () =>
  run(
    Effect.gen(function* () {
      yield* TestClock.adjust(Duration.days(1))

      const headers = yield* Signature.sign(secret, "msg_1", "{}")

      assert.equal(yield* Signature.verify(secret, headers, "{}"), true)
      assert.equal(yield* Signature.verify(Redacted.make("another"), headers, "{}"), false)
      assert.equal(yield* Signature.verify(secret, headers, "{ }"), false)
      assert.equal(yield* Signature.verify(secret, { ...headers, [Signature.idHeader]: "msg_2" }, "{}"), false)
      assert.equal(yield* Signature.verify(secret, { ...headers, [Signature.signatureHeader]: "v1,AA==" }, "{}"), false)

      for (const header of [Signature.idHeader, Signature.timestampHeader, Signature.signatureHeader]) {
        assert.equal(yield* Signature.verify(secret, { ...headers, [header]: undefined }, "{}"), false, header)
      }

      yield* TestClock.adjust(Duration.minutes(6))

      assert.equal(yield* Signature.verify(secret, headers, "{}"), false)
    }),
  ))

void test("an API call is authorized only by the bearer token of its own secret", () => {
  assert.equal(Signature.authorizes(secret, Signature.bearer(secret)), true)
  assert.equal(Signature.authorizes(secret, Signature.bearer(Redacted.make("another"))), false)
  assert.equal(Signature.authorizes(secret, Redacted.value(secret)), false)
  assert.equal(Signature.authorizes(secret, undefined), false)
})
