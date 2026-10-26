import { type ApiErrorResponse, createClient } from "@pay-tty/ledger-client"
import { Config, Context, Data, Effect, Layer, Schema } from "effect"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientError from "effect/unstable/http/HttpClientError"

export type Client = ReturnType<typeof createClient>

export class Service extends Context.Service<Service, Client>()("LedgerClient") {}

const make = Effect.gen(function* () {
  const baseUrl = yield* Config.String("LEDGER_BASE_URL")

  const httpClient = yield* HttpClient.HttpClient

  return createClient(httpClient, { baseUrl })
})

export const layer = Layer.effect(Service)(make)

/** How a call to the ledger failed, whatever the call was. */
export type Failure = ApiErrorResponse | HttpClientError.HttpClientError | Schema.SchemaError

export type Verdict = Data.TaggedEnum<{
  /** Worth retrying as-is. */
  Unavailable: {}
  /** The ledger answered with something other than the JSON promised. */
  BadResponse: { readonly reason: string }
  /** The ledger refused the request, with its error code. */
  Rejected: { readonly code: string }
  /** A 400: we sent what the ledger won't take, which the caller can't fix. */
  Invalid: { readonly response: ApiErrorResponse }
}>

export const Verdict = Data.taggedEnum<Verdict>()

// Transport failures and the ledger's own 500s are worth retrying as-is. An
// answer that isn't the JSON promised is ours to chase, a 400 is a request we
// built wrong, and anything else is the ledger refusing.
export const classify = (failure: Failure): Effect.Effect<Verdict> => {
  if (HttpClientError.isHttpClientError(failure)) {
    // The client reports an unparsable or missing body as an HTTP error too,
    // but the ledger did answer.
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
