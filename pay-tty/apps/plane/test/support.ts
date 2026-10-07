import { CreatePayableAccountRequestJson, createClient } from "@pay-tty/ledger-client"
import { Effect, Layer, Schema } from "effect"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientError from "effect/unstable/http/HttpClientError"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { ulid } from "ulid"

import { LedgerClient } from "../src/ledger/client.ts"
import { Token } from "../src/token/token.ts"

export const secret = () => crypto.getRandomValues(new Uint8Array(32))

// Signing moved from "previous" to "current"; "previous" still verifies
// within the overlap. A token under any other key id is rejected.
export const current = new Token.Key({ id: "current", secret: secret() })

export const previous = new Token.Key({ id: "previous", secret: secret() })

export const keys = new Token.Keys({ signing: current, verifying: [previous, current] })

export type Payload = CreatePayableAccountRequestJson

// What the ledger does with a create request. The ledger is a separate
// service, so it's the one thing these tests fake, at the HTTP boundary:
// the generated client and its decoding still run.
export type Reply =
  | { readonly status: number; readonly body: object }
  // Sent as is with a JSON content type, for answers that aren't JSON at all.
  | { readonly status: number; readonly raw: string }
  | "unreachable"

export const created = (payload: Payload): Reply => ({
  status: 201,
  body: {
    holder_reference: `hld_${ulid()}`,
    reference: `acct_${ulid()}`,
    ledger_slug: payload.ledger,
    external_id: payload.external_id,
    name: payload.name,
    kind: "payable",
    status: "open",
    closed_at: null,
    available: 0,
    balances: { debits_pending: 0, credits_pending: 0, debits_posted: 0, credits_posted: 0 },
    created_at: "2026-01-01T00:00:00Z",
  },
})

// Like the ledger: a repeat for the same business and ledger gets the account
// created first. It outlives any local transaction, as the real one does.
export const remembering = () => {
  const accounts = new Map<string, Reply>()

  return (payload: Payload): Reply => {
    const key = `${payload.ledger}:${payload.external_id}`
    const reply = accounts.get(key) ?? created(payload)

    accounts.set(key, reply)

    return reply
  }
}

export const failing = (status: number, code: string): Reply => ({
  status,
  body: { message: "The ledger could not complete the request.", error: { code } },
})

// A 400 the ledger's contract allows, so the client decodes it.
export const invalid: Reply = {
  status: 400,
  body: {
    message: "Request validation failed.",
    error: {
      code: "validation_error",
      details: [{ location: "body", field: "name", code: "invalid_value", message: "name is invalid" }],
    },
  },
}

export interface FakeLedger {
  readonly requests: ReadonlyArray<Payload>
  readonly replies: ReadonlyArray<Reply>
  readonly layer: Layer.Layer<LedgerClient.Service>
}

export const fakeLedger = (reply: (payload: Payload) => Reply = remembering()): FakeLedger => {
  const requests: Array<Payload> = []
  const replies: Array<Reply> = []

  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      const web = yield* Effect.orDie(HttpClientRequest.toWeb(request))

      const payload = yield* Effect.orDie(
        Schema.decodeUnknownEffect(CreatePayableAccountRequestJson)(yield* Effect.promise(() => web.json())),
      )

      const answer = reply(payload)

      requests.push(payload)

      replies.push(answer)

      if (answer === "unreachable") {
        return yield* new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, description: "connection refused" }),
        })
      }

      return HttpClientResponse.fromWeb(
        request,
        "raw" in answer
          ? new Response(answer.raw, { status: answer.status, headers: { "content-type": "application/json" } })
          : Response.json(answer.body, { status: answer.status }),
      )
    }),
  )

  return {
    requests,
    replies,
    // Built directly, so the tests need no LEDGER_BASE_URL.
    layer: Layer.succeed(LedgerClient.Service, createClient(http, { baseUrl: "http://ledger.test" })),
  }
}
