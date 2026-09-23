import * as Effect from "effect/Effect"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"

import {
  type CreatePayableAccountRequestJson,
  type GetAccountStatementParams,
  make,
  type OperationConfig,
  type PostJournalEntriesBatchRequestJson,
  type PostJournalEntryParams,
  type PostJournalEntryRequestJson,
} from "./generated.ts"

export * from "./generated.ts"

export interface ClientOptions {
  readonly baseUrl: string
}

export const createClient = (
  httpClient: HttpClient.HttpClient,
  options: ClientOptions,
) => {
  const client = make(httpClient, {
    transformClient: (client) =>
      Effect.succeed(
        client.pipe(
          HttpClient.mapRequest(HttpClientRequest.prependUrl(options.baseUrl)),
        ),
      ),
  })

  return {
    ...client,
    createPayableAccount: <Config extends OperationConfig>(request: {
      readonly payload: CreatePayableAccountRequestJson
      readonly config?: Config
    }) =>
      client.createPayableAccount(request).pipe(
        Effect.catchTags({
          CreatePayableAccount400: ({ cause }) => Effect.fail(cause),
          CreatePayableAccount409: ({ cause }) => Effect.fail(cause),
          CreatePayableAccount500: ({ cause }) => Effect.fail(cause),
        }),
      ),
    getAccount: <Config extends OperationConfig>(
      accountReference: string,
      request: { readonly config?: Config } | undefined,
    ) =>
      client.getAccount(accountReference, request).pipe(
        Effect.catchTags({
          GetAccount400: ({ cause }) => Effect.fail(cause),
          GetAccount404: ({ cause }) => Effect.fail(cause),
          GetAccount500: ({ cause }) => Effect.fail(cause),
        }),
      ),
    getAccountStatement: <Config extends OperationConfig>(
      accountReference: string,
      request: {
        readonly params?: GetAccountStatementParams
        readonly config?: Config
      } | undefined,
    ) =>
      client.getAccountStatement(accountReference, request).pipe(
        Effect.catchTags({
          GetAccountStatement400: ({ cause }) => Effect.fail(cause),
          GetAccountStatement404: ({ cause }) => Effect.fail(cause),
          GetAccountStatement500: ({ cause }) => Effect.fail(cause),
        }),
      ),
    postJournalEntry: <Config extends OperationConfig>(request: {
      readonly params: PostJournalEntryParams
      readonly payload: PostJournalEntryRequestJson
      readonly config?: Config
    }) =>
      client.postJournalEntry(request).pipe(
        Effect.catchTags({
          PostJournalEntry400: ({ cause }) => Effect.fail(cause),
          PostJournalEntry404: ({ cause }) => Effect.fail(cause),
          PostJournalEntry409: ({ cause }) => Effect.fail(cause),
          PostJournalEntry500: ({ cause }) => Effect.fail(cause),
        }),
      ),
    postJournalEntriesBatch: <Config extends OperationConfig>(request: {
      readonly payload: PostJournalEntriesBatchRequestJson
      readonly config?: Config
    }) =>
      client.postJournalEntriesBatch(request).pipe(
        Effect.catchTags({
          PostJournalEntriesBatch400: ({ cause }) => Effect.fail(cause),
          PostJournalEntriesBatch404: ({ cause }) => Effect.fail(cause),
          PostJournalEntriesBatch409: ({ cause }) => Effect.fail(cause),
          PostJournalEntriesBatch500: ({ cause }) => Effect.fail(cause),
        }),
      ),
  }
}

export type Client = ReturnType<typeof createClient>
