import { type ApiErrorResponse, createClient } from "@pay-tty/ledger-client"
import { Config, Context, Data, Effect, Layer, Schema } from "effect"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientError from "effect/unstable/http/HttpClientError"

export type Client = ReturnType<typeof createClient>

export class Service extends Context.Service<Service, Client>()("LedgerClient") {}

const make = Effect.gen(function* () {
  const baseUrl = yield* Config.String("LEDGER_URL")

  const httpClient = yield* HttpClient.HttpClient

  return createClient(httpClient, { baseUrl })
})

export const layer = Layer.effect(Service)(make)

/** Error union returned by ledger client calls. */
export type Failure = ApiErrorResponse | HttpClientError.HttpClientError | Schema.SchemaError

export type Verdict = Data.TaggedEnum<{
  /** Transient transport or server failure; safe to retry unchanged. */
  Unavailable: {}
  /** Response body failed JSON parsing or schema decoding. */
  BadResponse: { readonly reason: string }
  /** Domain rejection returned by the ledger (e.g. `insufficient_funds`). */
  Rejected: { readonly code: string }
  /** HTTP 400 validation error indicating a malformed request from plane. */
  Invalid: { readonly response: ApiErrorResponse }
}>

export const Verdict = Data.taggedEnum<Verdict>()

// Classifies a ledger client failure into a retry/refusal verdict.
export const classify = (failure: Failure): Effect.Effect<Verdict> => {
  if (HttpClientError.isHttpClientError(failure)) {
    // DecodeError and EmptyBodyError mean the server responded with an invalid payload.
    return failure.reason instanceof HttpClientError.DecodeError ||
        failure.reason instanceof HttpClientError.EmptyBodyError
      ? Effect.succeed(Verdict.BadResponse({ reason: failure.reason.message }))
      : Effect.succeed(Verdict.Unavailable())
  }

  if (Schema.isSchemaError(failure)) {
    return Effect.succeed(Verdict.BadResponse({ reason: failure.message }))
  }

  switch (failure.error.code) {
    case "internal_server_error":
      return Effect.succeed(Verdict.Unavailable())
    case "validation_error":
      return Effect.succeed(Verdict.Invalid({ response: failure }))
    default:
      return Effect.succeed(Verdict.Rejected({ code: failure.error.code }))
  }
}

export * as LedgerClient from "./client.ts"
