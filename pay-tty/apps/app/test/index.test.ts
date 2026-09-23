import assert from "node:assert/strict"
import { test } from "node:test"

import { Effect } from "effect"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"

import { ledgerClient } from "../src/ledger-client.ts"

void test("initializes the ledger client", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* ledgerClient

      assert.equal("getHealth" in client, true)
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  ),
)
