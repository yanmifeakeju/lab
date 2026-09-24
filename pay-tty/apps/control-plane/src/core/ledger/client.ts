import { createClient } from "@pay-tty/ledger-client"
import { Config, Context, Effect, Layer } from "effect"
import * as HttpClient from "effect/unstable/http/HttpClient"

export type Client = ReturnType<typeof createClient>

export class Service extends Context.Service<Service, Client>()("LedgerClient") {}

const make = Effect.gen(function* () {
  const baseUrl = yield* Config.String("LEDGER_BASE_URL").pipe(
    Config.withDefault("http://localhost:8080"),
  )

  const httpClient = yield* HttpClient.HttpClient

  return createClient(httpClient, { baseUrl })
})

export const layer = Layer.effect(Service)(make)

export * as LedgerClient from "./client.ts"
