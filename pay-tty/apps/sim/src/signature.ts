// How the sim authenticates, as real providers do: API calls carry the API key
// as a bearer token, and callbacks are signed per Standard Webhooks
// (https://www.standardwebhooks.com), over id, timestamp and body only, so a
// proxy rewriting the path doesn't break them. Node's crypto gives HMAC and a
// constant-time compare; Effect has neither.
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { createHmac, timingSafeEqual } from "node:crypto"

import { Clock, Config, Duration, Effect, Redacted } from "effect"

const same = (given: string, expected: string) => {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)

  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * SIM_API_KEY and SIM_WEBHOOK_SECRET. The API key travels with every call, so
 * one equal to the webhook secret could sign callbacks; that's refused.
 */
export const keys = Effect.gen(function* () {
  const apiKey = yield* Config.Redacted("SIM_API_KEY")
  const webhookSecret = yield* Config.Redacted("SIM_WEBHOOK_SECRET")

  if (Redacted.value(apiKey) === Redacted.value(webhookSecret)) {
    return yield* Effect.die(new Error("SIM_API_KEY and SIM_WEBHOOK_SECRET must differ"))
  }

  return { apiKey, webhookSecret }
})

/** The `Authorization` header value an API call carries. */
export const bearer = (secret: Redacted.Redacted) => `Bearer ${Redacted.value(secret)}`

/** Whether an `Authorization` header carries `secret`. */
export const authorizes = (secret: Redacted.Redacted, header: string | undefined) =>
  header !== undefined && same(header, bearer(secret))

export const idHeader = "webhook-id"

export const timestampHeader = "webhook-timestamp"

export const signatureHeader = "webhook-signature"

/** The headers a signed callback carries. */
export type Signed = {
  [idHeader]: string
  [timestampHeader]: string
  [signatureHeader]: string
}

/** How far a callback's timestamp may be from the receiver's clock. */
export const window = Duration.minutes(5)

const signature = (secret: Redacted.Redacted, id: string, timestamp: string, body: string) =>
  `v1,${createHmac("sha256", Redacted.value(secret)).update(`${id}.${timestamp}.${body}`).digest("base64")}`

/** The headers that sign callback `id` with `body`, timestamped now. Retries of one callback reuse its id. */
export const sign = (secret: Redacted.Redacted, id: string, body: string) =>
  Effect.map(Clock.currentTimeMillis, (now): Signed => {
    const timestamp = String(Math.floor(now / 1000))

    return { [idHeader]: id, [timestampHeader]: timestamp, [signatureHeader]: signature(secret, id, timestamp, body) }
  })

/** Whether the headers sign `body`, within `window` of now. */
export const verify = (secret: Redacted.Redacted, headers: { readonly [name: string]: string | undefined }, body: string) =>
  Effect.map(Clock.currentTimeMillis, (now) => {
    const id = headers[idHeader]
    const timestamp = headers[timestampHeader]
    const given = headers[signatureHeader]

    if (id === undefined || timestamp === undefined || given === undefined || !/^\d{1,12}$/.test(timestamp)) {
      return false
    }

    if (Math.abs(now / 1000 - Number(timestamp)) > Duration.toSeconds(window)) {
      return false
    }

    return same(given, signature(secret, id, timestamp, body))
  })

export * as Signature from "./signature.ts"
