import { Config, Effect } from "effect"
import * as HttpClient from "effect/unstable/http/HttpClient"

import { createClient } from "@pay-tty/ledger-client"

export const ledgerClient = Effect.gen(function* () {
  const baseUrl = yield* Config.String("LEDGER_BASE_URL").pipe(
    Config.withDefault("http://localhost:8080"),
  )

  const httpClient = yield* HttpClient.HttpClient

  return createClient(httpClient, { baseUrl })
})
