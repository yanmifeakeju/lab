import { createClient } from "@pay-tty/plane-client"
import { Config, Context, Effect, Layer } from "effect"
import * as HttpClient from "effect/unstable/http/HttpClient"

export type Client = ReturnType<typeof createClient>

export class Service extends Context.Service<Service, Client>()("Plane") {}

const make = Effect.gen(function* () {
  const baseUrl = yield* Config.String("PLANE_BASE_URL")

  const httpClient = yield* HttpClient.HttpClient

  return createClient(httpClient, { baseUrl })
})

export const layer = Layer.effect(Service)(make)

export * as Plane from "./plane.ts"
