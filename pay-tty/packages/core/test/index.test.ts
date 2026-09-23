import assert from "node:assert/strict"
import { test } from "node:test"

import { Effect } from "effect"

import { greeting } from "../src/index.ts"

void test("creates a greeting effect", () => {
  assert.equal(Effect.runSync(greeting("core")), "Hello from core!")
})
