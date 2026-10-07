import assert from "node:assert/strict"
import { test } from "node:test"

import { createId } from "../src/database/ids.ts"

void test("creates prefixed monotonic identifiers", () => {
  const first = createId("prn")
  const second = createId("prn")

  assert.match(first, /^prn_[0-9A-HJKMNP-TV-Z]{26}$/)
  assert.match(second, /^prn_[0-9A-HJKMNP-TV-Z]{26}$/)
  assert.notEqual(first, second)
})
