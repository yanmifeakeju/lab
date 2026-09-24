import assert from "node:assert/strict"
import { test } from "node:test"

import { NodeHttpServer } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import * as HttpApiTest from "effect/unstable/httpapi/HttpApiTest"

import { api } from "../src/server/api/index.ts"
import { HealthLive } from "../src/server/handler/health.ts"
import { SchemaErrorLive } from "../src/server/middleware/schema-error.ts"

void test("serves the health endpoint", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* HttpApiTest.groups(api, ["health"])
      const health = yield* client.health.getHealth()

      assert.equal(health.status, "ok")
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          HealthLive.pipe(Layer.provideMerge(SchemaErrorLive)),
          NodeHttpServer.layerHttpServices,
        ),
      ),
    ),
  ),
)
