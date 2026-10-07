import assert from "node:assert/strict"
import { test } from "node:test"

import { Principal } from "@pay-tty/core/principal"
import { ConfigProvider, Effect, Encoding, Exit, Layer, Redacted } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { decodeJwt, decodeProtectedHeader } from "jose"
import { ulid } from "ulid"

import { Token } from "../src/token/token.ts"
import { keys, secret } from "./support.ts"

const principal = Principal.ID.make(`prn_${ulid()}`)

const withTokens = <A, E>(effect: Effect.Effect<A, E, Token.Service | TestClock.TestClock>) =>
  Effect.runPromise(effect.pipe(Effect.provide(Layer.mergeAll(Token.layerFrom(keys), TestClock.layer()))))

const fromConfig = (env: Record<string, string>) =>
  Effect.runPromise(
    Effect.exit(Token.keysFromConfig).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(env)))),
  )

void test("issues a token with the agreed header and claims", () =>
  withTokens(
    Effect.gen(function* () {
      const tokens = yield* Token.Service
      yield* TestClock.setTime(1_800_000_000_000)

      const issued = yield* tokens.issue(principal)
      const token = Redacted.value(issued.accessToken)

      assert.equal(issued.expiresIn, 900)
      assert.deepEqual(decodeProtectedHeader(token), { alg: "HS256", typ: "at+jwt", kid: "current" })
      assert.deepEqual(decodeJwt(token), {
        iss: "pay-tty-plane",
        aud: "pay-tty-plane",
        sub: principal,
        iat: 1_800_000_000,
        exp: 1_800_000_900,
      })
    }),
  ))

void test("verifies its own tokens, including after a restart with the same keys", () =>
  withTokens(
    Effect.gen(function* () {
      const tokens = yield* Token.Service
      const token = Redacted.value((yield* tokens.issue(principal)).accessToken)

      assert.equal(yield* tokens.verify(token), principal)

      const restarted = yield* Token.Service.pipe(Effect.provide(Token.layerFrom(keys)))

      assert.equal(yield* restarted.verify(token), principal)
    }),
  ))

void test("expires after its lifetime plus the allowed skew", () =>
  withTokens(
    Effect.gen(function* () {
      const tokens = yield* Token.Service
      const token = Redacted.value((yield* tokens.issue(principal)).accessToken)

      yield* TestClock.adjust("15 minutes")
      yield* TestClock.adjust("29 seconds")

      assert.equal(yield* tokens.verify(token), principal)

      yield* TestClock.adjust("2 seconds")

      const rejected = yield* Effect.flip(tokens.verify(token))

      assert.equal(rejected._tag, "Token.InvalidTokenError")
    }),
  ))

const encoded = Encoding.encodeBase64Url(secret())

void test("reads keys from config", () =>
  fromConfig({
    PLANE_TOKEN_KEYS: `old:${encoded}, new:${Encoding.encodeBase64Url(secret())}`,
    PLANE_TOKEN_SIGNING_KEY_ID: "new",
  }).then((exit) => {
    assert.ok(Exit.isSuccess(exit))
    assert.equal(exit.value.signing.id, "new")
    assert.deepEqual(exit.value.verifying.map((key) => key.id), ["old", "new"])
  }))

void test("refuses key config it can't trust", () =>
  Promise.all([
    fromConfig({ PLANE_TOKEN_SIGNING_KEY_ID: "a" }),
    fromConfig({ PLANE_TOKEN_KEYS: `a:${encoded}` }),
    fromConfig({ PLANE_TOKEN_KEYS: `a:${encoded}`, PLANE_TOKEN_SIGNING_KEY_ID: "b" }),
    fromConfig({ PLANE_TOKEN_KEYS: `a:${Encoding.encodeBase64Url(new Uint8Array(31))}`, PLANE_TOKEN_SIGNING_KEY_ID: "a" }),
    fromConfig({ PLANE_TOKEN_KEYS: `a:${encoded}!`, PLANE_TOKEN_SIGNING_KEY_ID: "a" }),
    fromConfig({ PLANE_TOKEN_KEYS: `a:${encoded},a:${encoded}`, PLANE_TOKEN_SIGNING_KEY_ID: "a" }),
    fromConfig({ PLANE_TOKEN_KEYS: `a b:${encoded}`, PLANE_TOKEN_SIGNING_KEY_ID: "a b" }),
  ]).then((exits) => {
    for (const exit of exits) {
      assert.ok(Exit.isFailure(exit))
    }
  }))
