import { maxAmount } from "@pay-tty/database/columns"
import { Api, Signature } from "../api.ts"
import { Config, Duration, Effect, Layer, Option, Redacted, Result, Schema } from "effect"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"

import { SimDatabase } from "../database.ts"
import { Store } from "../payouts/store.ts"

/** How long a transfer processes before its outcome is final, unless configured. */
export const defaultDelay = Duration.seconds(5)

const SendBody = Schema.fromJsonString(Api.SendRequest)

const error = (status: number, code: string) =>
  HttpServerResponse.jsonUnsafe(Api.ErrorBody.make({ error: { code } }), { status })

const pathOf = (request: HttpServerRequest.HttpServerRequest) => new URL(request.url, "http://sim").pathname

const authorized = (secret: Redacted.Redacted, request: HttpServerRequest.HttpServerRequest) =>
  Signature.authorizes(secret, request.headers["authorization"])

// The body of an authorized call; null when it isn't one, or can't be read.
const authorizedBody = (secret: Redacted.Redacted, request: HttpServerRequest.HttpServerRequest) =>
  authorized(secret, request) ? request.text.pipe(Effect.orElseSucceed(() => null)) : Effect.succeed(null)

const send = (secret: Redacted.Redacted) => (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    const body = yield* authorizedBody(secret, request)

    if (body === null) {
      return error(401, Api.errors.unauthorized)
    }

    const decoded = Schema.decodeOption(SendBody)(body)

    if (Option.isNone(decoded) || BigInt(decoded.value.amount) > maxAmount) {
      return error(400, Api.errors.invalidPayout)
    }

    const { reference, ledger, amount, destination } = decoded.value

    const accepted = yield* Effect.result(Store.accept({ reference, ledger, amount: BigInt(amount), ...destination }))

    if (Result.isFailure(accepted)) {
      return error(409, Api.errors.referenceReused)
    }

    return HttpServerResponse.jsonUnsafe(
      Api.Accepted.make({ reference, providerRef: accepted.success.providerRef }),
      { status: accepted.success.created ? 201 : 200 },
    )
  })

const get = (secret: Redacted.Redacted, delay: Duration.Duration) => (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    if (!authorized(secret, request)) {
      return error(401, Api.errors.unauthorized)
    }

    const reference = decodeURIComponent(pathOf(request).slice(`${Api.sendPath}/`.length))
    const found = yield* Store.lookup(reference, delay)

    if (found === undefined) {
      return HttpServerResponse.jsonUnsafe(Api.NotFound.make({ error: { code: Api.errors.notFound } }), { status: 404 })
    }

    return HttpServerResponse.jsonUnsafe(Api.Found.make({ reference, ...found }))
  })

// A database failure is a defect; the caller gets a 500 and the server keeps serving.
const ServerError = HttpRouter.middleware(
  (effect) =>
    Effect.catchDefect(effect, (defect) =>
      Effect.as(Effect.logError("sim request failed", defect), error(500, Api.errors.internal))),
  { global: true },
)

/** The provider's API, authorized by SIM_API_KEY as a bearer token, finalises after SIM_PAYOUT_DELAY. */
export const routes = Layer.unwrap(
  Effect.gen(function* () {
    const secret = yield* Config.Redacted("SIM_API_KEY")
    const delay = yield* Config.Duration("SIM_PAYOUT_DELAY").pipe(Config.withDefault(defaultDelay))
    const database = yield* SimDatabase

    const handle = (handler: (request: HttpServerRequest.HttpServerRequest) => Effect.Effect<HttpServerResponse.HttpServerResponse, never, SimDatabase>) =>
      (request: HttpServerRequest.HttpServerRequest) => Effect.provideService(handler(request), SimDatabase, database)

    return Layer.mergeAll(
      HttpRouter.add("POST", Api.sendPath, handle(send(secret))),
      HttpRouter.add("GET", Api.lookupRoute, handle(get(secret, delay))),
      ServerError,
    )
  }),
)
