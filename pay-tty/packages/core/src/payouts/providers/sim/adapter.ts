import { Api, Signature } from "@pay-tty/sim/api"
import { Config, Effect, Layer, Option, Schema } from "effect"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"

import { ID } from "../../payouts.ts"
import { PayoutProvider } from "../../provider.ts"

const SendBody = Schema.fromJsonString(Api.SendRequest)

// The sim's answers, read into plane's types: a payout ID, and a ref that is never blank.
const Callback = Schema.fromJsonString(Schema.Struct({ ...Api.Callback.fields, reference: ID, providerRef: PayoutProvider.ProviderRef }))

const Accepted = Schema.Struct({ ...Api.Accepted.fields, providerRef: PayoutProvider.ProviderRef })

// A pending answer's ref, if any, is ignored.
const Found = Schema.Union([
  Schema.Struct({ reference: Schema.String, status: Schema.Literal("pending") }),
  Schema.Struct({ reference: Schema.String, status: Schema.Literals(["paid", "failed"]), providerRef: PayoutProvider.ProviderRef }),
])

const failure = (message: string) => new PayoutProvider.ProviderError({ message })

// Send statuses that mean this payout is wrong: invalid, or its reference reused.
const refusals = new Set([400, 409, 422])

/**
 * The simulated provider over HTTP at SIM_URL. Calls carry SIM_API_KEY as a
 * bearer token, and callbacks are signed with SIM_WEBHOOK_SECRET. A send the
 * sim rejects as wrong for this payout is a `RefusedError`; any other failed
 * or unreadable answer is a `ProviderError`, retried.
 */
export const make = Effect.gen(function* () {
  const base = yield* Config.String("SIM_URL")
  const { apiKey, webhookSecret } = yield* Signature.keys({ apiKey: "SIM_API_KEY", webhookSecret: "SIM_WEBHOOK_SECRET" })
  const client = yield* HttpClient.HttpClient

  const call = (method: "GET" | "POST", path: string, body: string) =>
    Effect.gen(function* () {
      // Joined, not resolved, so a path prefix in SIM_URL is kept.
      const url = new URL(`${base.replace(/\/+$/, "")}${path}`)

      const request = method === "POST"
        ? HttpClientRequest.post(url).pipe(HttpClientRequest.bodyText(body, "application/json"))
        : HttpClientRequest.get(url)

      return yield* client.execute(HttpClientRequest.setHeader(request, "authorization", Signature.bearer(apiKey)))
    }).pipe(Effect.mapError((error) => failure(`provider unreachable: ${error.message}`)))

  const decode = <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S, response: HttpClientResponse.HttpClientResponse) =>
    response.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(schema)),
      Effect.mapError(() => failure(`provider answered ${response.status} with an unreadable body`)),
    )

  return PayoutProvider.Service.of({
    send: (transfer) =>
      Effect.gen(function* () {
        const body = yield* Schema.encodeEffect(SendBody)({
          reference: transfer.payoutId,
          ledger: transfer.ledger,
          currency: transfer.currencyCode,
          amount: transfer.amount.toString(),
          destination: {
            bankCode: transfer.destination.bankCode,
            accountNumber: transfer.destination.accountNumber,
            accountName: transfer.destination.accountName,
          },
        }).pipe(
          // The sim would refuse what its API can't express.
          Effect.mapError((error) => new PayoutProvider.RefusedError({ message: `the sim's API can't carry the payout: ${error.message}` })),
        )

        const response = yield* call("POST", Api.sendPath, body)

        // Wrong for this payout, so permanent. Others, such as a bad key (401) or a
        // wrong route (404), are config, and recover once it's fixed.
        if (refusals.has(response.status)) {
          const code = yield* response.json.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Api.ErrorBody)),
            Effect.map(({ error }) => ` (${error.code})`),
            Effect.orElseSucceed(() => ""),
          )

          return yield* new PayoutProvider.RefusedError({ message: `provider refused the payout with ${response.status}${code}` })
        }

        if (response.status !== 200 && response.status !== 201) {
          return yield* failure(`provider answered the send with ${response.status}`)
        }

        const accepted = yield* decode(Accepted, response)

        if (accepted.reference !== transfer.payoutId) {
          return yield* failure(`provider answered the send for another reference, ${accepted.reference}`)
        }

        return accepted.providerRef
      }),
    standing: (transfer) =>
      Effect.gen(function* () {
        const response = yield* call("GET", Api.lookupPath(transfer.payoutId), "")

        // No record of the reference, and the provider vouches it never paid.
        // A 404 without the sim's not-found error may be a proxy's, which vouches for nothing.
        if (response.status === 404) {
          return yield* decode(Api.NotFound, response).pipe(Effect.as({ status: "not_received" } as const))
        }

        if (response.status !== 200) {
          return yield* failure(`provider answered the status check with ${response.status}`)
        }

        const found = yield* decode(Found, response)

        if (found.reference !== transfer.payoutId) {
          return yield* failure(`provider answered the status check for another reference, ${found.reference}`)
        }

        switch (found.status) {
          case "pending":
            return { status: "pending" } as const
          case "paid":
            return { status: "paid", providerRef: found.providerRef } as const
          case "failed":
            return { status: "unpaid", providerRef: found.providerRef } as const
        }
      }),
    callback: ({ headers, body }) =>
      Effect.gen(function* () {
        if (!(yield* Signature.verify(webhookSecret, headers, body))) {
          return yield* new PayoutProvider.InvalidCallback({ reason: "unauthenticated" })
        }

        const callback = Schema.decodeOption(Callback)(body)

        if (Option.isNone(callback)) {
          return yield* new PayoutProvider.InvalidCallback({ reason: "malformed" })
        }

        const { reference, outcome, providerRef } = callback.value

        return new PayoutProvider.Reported({ payoutId: reference, outcome, providerRef })
      }),
  })
})

export const layer = Layer.effect(PayoutProvider.Service)(make)

export * as SimProvider from "./adapter.ts"
