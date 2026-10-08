import * as Effect from "effect/Effect"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"

import { type CreateBusinessRequestEncoded, make, type OperationConfig, type SessionRequestEncoded } from "./generated.ts"

export * from "./generated.ts"

export interface ClientOptions {
  readonly baseUrl: string
}

const at = (httpClient: HttpClient.HttpClient, options: ClientOptions, token?: string) =>
  make(httpClient, {
    transformClient: (client) =>
      Effect.succeed(
        client.pipe(
          HttpClient.mapRequest(HttpClientRequest.prependUrl(options.baseUrl)),
          HttpClient.mapRequest((request) =>
            token === undefined ? request : HttpClientRequest.bearerToken(request, token),
          ),
        ),
      ),
  })

/**
 * Plane's routes, failing with the decoded error body for every declared
 * error response, so callers branch on `error.code`. Any other status, such
 * as a 500, is an HttpClientError.
 */
export const createClient = (httpClient: HttpClient.HttpClient, options: ClientOptions) => {
  const open = at(httpClient, options)

  return {
    createSession: <Config extends OperationConfig>(request: {
      readonly payload: SessionRequestEncoded
      readonly config?: Config
    }) =>
      open.sessionCreateSession(request).pipe(
        Effect.catchTags({
          SessionCreateSession400: ({ cause }) => Effect.fail(cause),
          SessionCreateSession403: ({ cause }) => Effect.fail(cause),
        }),
      ),
    /** The routes that take the access token `createSession` issued. */
    authorized: (token: string) => {
      const client = at(httpClient, options, token)

      return {
        me: <Config extends OperationConfig>(request: { readonly config?: Config } | undefined) =>
          client.meMe(request).pipe(
            Effect.catchTags({
              MeMe400: ({ cause }) => Effect.fail(cause),
              MeMe401: ({ cause }) => Effect.fail(cause),
            }),
          ),
        createBusiness: <Config extends OperationConfig>(request: {
          readonly payload: CreateBusinessRequestEncoded
          readonly config?: Config
        }) =>
          client.businessCreateBusiness(request).pipe(
            Effect.catchTags({
              BusinessCreateBusiness400: ({ cause }) => Effect.fail(cause),
              BusinessCreateBusiness401: ({ cause }) => Effect.fail(cause),
              BusinessCreateBusiness409: ({ cause }) => Effect.fail(cause),
              BusinessCreateBusiness503: ({ cause }) => Effect.fail(cause),
            }),
          ),
        createBusinessLedger: <Config extends OperationConfig>(
          businessId: string,
          request: { readonly config?: Config } | undefined,
        ) =>
          client.businessCreateBusinessLedger(businessId, request).pipe(
            Effect.catchTags({
              BusinessCreateBusinessLedger400: ({ cause }) => Effect.fail(cause),
              BusinessCreateBusinessLedger401: ({ cause }) => Effect.fail(cause),
              BusinessCreateBusinessLedger404: ({ cause }) => Effect.fail(cause),
              BusinessCreateBusinessLedger409: ({ cause }) => Effect.fail(cause),
              BusinessCreateBusinessLedger502: ({ cause }) => Effect.fail(cause),
              BusinessCreateBusinessLedger503: ({ cause }) => Effect.fail(cause),
            }),
          ),
      }
    },
  }
}

export type Client = ReturnType<typeof createClient>

export type AuthorizedClient = ReturnType<Client["authorized"]>
