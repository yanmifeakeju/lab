import { type BusinessInfoEncoded, createClient } from "@pay-tty/plane-client"
import { Effect, Layer, Match, Schema } from "effect"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientError from "effect/unstable/http/HttpClientError"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"

import { Plane } from "../src/plane.ts"

export interface Call {
  readonly method: string
  readonly path: string
  readonly authorization: string | null
  readonly body: unknown
}

// "hang" never answers, so a test can see a disconnect cancel the request.
export type Reply = { readonly status: number; readonly body: object } | "unreachable" | "hang"

export interface Routes {
  readonly session?: (call: Call) => Reply
  readonly me?: (call: Call) => Reply
  readonly createBusiness?: (call: Call) => Reply
  readonly openLedger?: (call: Call) => Reply
}

export const business = (fields: Partial<BusinessInfoEncoded> = {}): BusinessInfoEncoded => ({
  id: "biz_1",
  name: "Acme Ltd",
  country_code: "NG",
  currency_code: "NGN",
  holder_ref: null,
  status: "created",
  ledger: null,
  created_at: "2026-10-08T00:00:00.000Z",
  updated_at: "2026-10-08T00:00:00.000Z",
  ...fields,
})

export const active = business({
  status: "active",
  holder_ref: "hld_1",
  ledger: { slug: "ngn_ng", currency: "NGN", scale: 2, payable_account_ref: "acct_1" },
})

export const failure = (status: number, code: string): Reply => ({ status, body: { message: "Refused.", error: { code } } })

export const unauthorized = failure(401, "unauthorized")

// Each exchange issues a new token, so a test can see which one a call used.
export const sessions = (expiresIn = 900) => {
  let issued = 0

  return (): Reply => {
    issued += 1

    return { status: 200, body: { accessToken: `tok_${issued}`, tokenType: "Bearer", expiresIn } }
  }
}

export const Json = Schema.fromJsonString(Schema.Unknown)

// Plane is the one thing faked, at the HTTP boundary, so the generated
// client's encoding and decoding still run.
export const fakePlane = (routes: Routes) => {
  const calls: Array<Call> = []
  const session = routes.session ?? sessions()

  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      const web = yield* Effect.orDie(HttpClientRequest.toWeb(request))
      const url = new URL(web.url)
      const text = yield* Effect.promise(() => web.text())

      const call: Call = {
        method: web.method,
        path: url.pathname,
        authorization: web.headers.get("authorization"),
        body: text === "" ? null : yield* Effect.orDie(Schema.decodeEffect(Json)(text)),
      }

      calls.push(call)

      const route = Match.value(call.path).pipe(
        Match.when("/session", () => session),
        Match.when("/me", () => routes.me),
        Match.when("/business", () => routes.createBusiness),
        Match.orElse(() => routes.openLedger),
      )

      const reply = route?.(call) ?? { status: 404, body: {} }

      if (reply === "hang") {
        return yield* Effect.never
      }

      if (reply === "unreachable") {
        return yield* new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, description: "connection refused" }),
        })
      }

      return HttpClientResponse.fromWeb(request, Response.json(reply.body, { status: reply.status }))
    }),
  )

  return {
    calls,
    layer: Layer.succeed(Plane.Service, createClient(http, { baseUrl: "http://plane.test" })),
  }
}


// Runs a test body; node:test wants a promise.
export const scenario = <A>(body: Effect.Effect<A>) => () => Effect.runPromise(body)

export const me = (shown: BusinessInfoEncoded | null) => (): Reply => ({
  status: 200,
  body: { id: "prn_1", created_at: "2026-10-08T00:00:00.000Z", business: shown },
})

// Replies in order, then the last one for every later call.
export const inTurn = (...replies: ReadonlyArray<Reply>) => {
  const queue = [...replies]

  return (): Reply => (queue.length > 1 ? (queue.shift() ?? "unreachable") : (queue[0] ?? "unreachable"))
}

