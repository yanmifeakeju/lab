import * as Effect from "effect/Effect"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"

import {
  type BusinessGetStatementParams,
  type CreateBusinessRequestEncoded,
  type CreatePaymentLinkRequestEncoded,
  make,
  type OperationConfig,
  type PaymentLinksCreatePaymentLinkParams,
  type PaymentsListPaymentsParams,
  type PayoutRequestEncoded,
  type PayoutSettingsRequestEncoded,
  type PayoutsListPayoutsParams,
  type PayStartPaymentParams,
  type SessionRequestEncoded,
  type SimulatePaymentRequestEncoded,
  type StartPaymentRequestEncoded,
} from "./generated.ts"

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
    /**
     * A customer paying a link: no access token, and the link's share token
     * is the only credential.
     */
    pay: {
      paymentLink: <Config extends OperationConfig>(shareToken: string, request?: { readonly config?: Config }) =>
        open.payPaymentLink(shareToken, request).pipe(
          Effect.catchTags({
            PayPaymentLink400: ({ cause }) => Effect.fail(cause),
            PayPaymentLink404: ({ cause }) => Effect.fail(cause),
          }),
        ),
      /** A new payment answers 201 and a repeat of its key 200, with the same body. */
      startPayment: <Config extends OperationConfig>(
        shareToken: string,
        request: {
          readonly params: PayStartPaymentParams
          readonly payload: StartPaymentRequestEncoded
          readonly config?: Config
        },
      ) =>
        open.payStartPayment(shareToken, request).pipe(
          Effect.catchTags({
            PayStartPayment400: ({ cause }) => Effect.fail(cause),
            PayStartPayment404: ({ cause }) => Effect.fail(cause),
            PayStartPayment409: ({ cause }) => Effect.fail(cause),
          }),
        ),
      simulatePayment: <Config extends OperationConfig>(
        shareToken: string,
        paymentId: string,
        request: { readonly payload: SimulatePaymentRequestEncoded; readonly config?: Config },
      ) =>
        open.paySimulatePayment(shareToken, paymentId, request).pipe(
          Effect.catchTags({
            PaySimulatePayment400: ({ cause }) => Effect.fail(cause),
            PaySimulatePayment404: ({ cause }) => Effect.fail(cause),
            PaySimulatePayment409: ({ cause }) => Effect.fail(cause),
          }),
        ),
    },
    /**
     * The routes that take the access token `createSession` issued. Those
     * acting on a business act on the token's.
     */
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
        createAccount: <Config extends OperationConfig>(request: { readonly config?: Config } | undefined) =>
          client.businessCreateAccount(request).pipe(
            Effect.catchTags({
              BusinessCreateAccount400: ({ cause }) => Effect.fail(cause),
              BusinessCreateAccount401: ({ cause }) => Effect.fail(cause),
              BusinessCreateAccount409: ({ cause }) => Effect.fail(cause),
              BusinessCreateAccount502: ({ cause }) => Effect.fail(cause),
              BusinessCreateAccount503: ({ cause }) => Effect.fail(cause),
            }),
          ),
        getBalance: <Config extends OperationConfig>(request: { readonly config?: Config } | undefined) =>
          client.businessGetBalance(request).pipe(
            Effect.catchTags({
              BusinessGetBalance400: ({ cause }) => Effect.fail(cause),
              BusinessGetBalance401: ({ cause }) => Effect.fail(cause),
              BusinessGetBalance409: ({ cause }) => Effect.fail(cause),
              BusinessGetBalance502: ({ cause }) => Effect.fail(cause),
              BusinessGetBalance503: ({ cause }) => Effect.fail(cause),
            }),
          ),
        getStatement: <Config extends OperationConfig>(request: {
          readonly params?: BusinessGetStatementParams
          readonly config?: Config
        } | undefined) =>
          client.businessGetStatement(request).pipe(
            Effect.catchTags({
              BusinessGetStatement400: ({ cause }) => Effect.fail(cause),
              BusinessGetStatement401: ({ cause }) => Effect.fail(cause),
              BusinessGetStatement409: ({ cause }) => Effect.fail(cause),
              BusinessGetStatement502: ({ cause }) => Effect.fail(cause),
              BusinessGetStatement503: ({ cause }) => Effect.fail(cause),
            }),
          ),
        /** A new link answers 201 and a repeat of its key 200, with the same body. */
        createPaymentLink: <Config extends OperationConfig>(
          request: {
            readonly params: PaymentLinksCreatePaymentLinkParams
            readonly payload: CreatePaymentLinkRequestEncoded
            readonly config?: Config
          },
        ) =>
          client.paymentLinksCreatePaymentLink(request).pipe(
            Effect.catchTags({
              PaymentLinksCreatePaymentLink400: ({ cause }) => Effect.fail(cause),
              PaymentLinksCreatePaymentLink401: ({ cause }) => Effect.fail(cause),
              PaymentLinksCreatePaymentLink409: ({ cause }) => Effect.fail(cause),
            }),
          ),
        listPayments: <Config extends OperationConfig>(request: {
          readonly params?: PaymentsListPaymentsParams
          readonly config?: Config
        } | undefined) =>
          client.paymentsListPayments(request).pipe(
            Effect.catchTags({
              PaymentsListPayments400: ({ cause }) => Effect.fail(cause),
              PaymentsListPayments401: ({ cause }) => Effect.fail(cause),
              PaymentsListPayments404: ({ cause }) => Effect.fail(cause),
              PaymentsListPayments409: ({ cause }) => Effect.fail(cause),
            }),
          ),
        getPayment: <Config extends OperationConfig>(paymentId: string, request?: { readonly config?: Config }) =>
          client.paymentsGetPayment(paymentId, request).pipe(
            Effect.catchTags({
              PaymentsGetPayment400: ({ cause }) => Effect.fail(cause),
              PaymentsGetPayment401: ({ cause }) => Effect.fail(cause),
              PaymentsGetPayment404: ({ cause }) => Effect.fail(cause),
              PaymentsGetPayment409: ({ cause }) => Effect.fail(cause),
            }),
          ),
        listPaymentLinks: <Config extends OperationConfig>(request: { readonly config?: Config } | undefined) =>
          client.paymentLinksListPaymentLinks(request).pipe(
            Effect.catchTags({
              PaymentLinksListPaymentLinks400: ({ cause }) => Effect.fail(cause),
              PaymentLinksListPaymentLinks401: ({ cause }) => Effect.fail(cause),
              PaymentLinksListPaymentLinks409: ({ cause }) => Effect.fail(cause),
            }),
          ),
        listBanks: <Config extends OperationConfig>(request: { readonly config?: Config } | undefined) =>
          client.payoutsListBanks(request).pipe(
            Effect.catchTags({
              PayoutsListBanks400: ({ cause }) => Effect.fail(cause),
              PayoutsListBanks401: ({ cause }) => Effect.fail(cause),
              PayoutsListBanks409: ({ cause }) => Effect.fail(cause),
            }),
          ),
        getPayoutSettings: <Config extends OperationConfig>(request: { readonly config?: Config } | undefined) =>
          client.payoutsGetPayoutSettings(request).pipe(
            Effect.catchTags({
              PayoutsGetPayoutSettings400: ({ cause }) => Effect.fail(cause),
              PayoutsGetPayoutSettings401: ({ cause }) => Effect.fail(cause),
              PayoutsGetPayoutSettings409: ({ cause }) => Effect.fail(cause),
            }),
          ),
        changePayoutSettings: <Config extends OperationConfig>(request: {
          readonly payload: PayoutSettingsRequestEncoded
          readonly config?: Config
        }) =>
          client.payoutsChangePayoutSettings(request).pipe(
            Effect.catchTags({
              PayoutsChangePayoutSettings400: ({ cause }) => Effect.fail(cause),
              PayoutsChangePayoutSettings401: ({ cause }) => Effect.fail(cause),
              PayoutsChangePayoutSettings409: ({ cause }) => Effect.fail(cause),
            }),
          ),
        /** Moves no money: the payout waits to be confirmed, and expires if it isn't in time. */
        createPayout: <Config extends OperationConfig>(request: {
          readonly payload: PayoutRequestEncoded
          readonly config?: Config
        }) =>
          client.payoutsCreatePayout(request).pipe(
            Effect.catchTags({
              PayoutsCreatePayout400: ({ cause }) => Effect.fail(cause),
              PayoutsCreatePayout401: ({ cause }) => Effect.fail(cause),
              PayoutsCreatePayout409: ({ cause }) => Effect.fail(cause),
            }),
          ),
        /** Confirming answers 202, and confirming again 200, with the payout as it stands. */
        confirmPayout: <Config extends OperationConfig>(payoutId: string, request?: { readonly config?: Config }) =>
          client.payoutsConfirmPayout(payoutId, request).pipe(
            Effect.catchTags({
              PayoutsConfirmPayout400: ({ cause }) => Effect.fail(cause),
              PayoutsConfirmPayout401: ({ cause }) => Effect.fail(cause),
              PayoutsConfirmPayout404: ({ cause }) => Effect.fail(cause),
              PayoutsConfirmPayout409: ({ cause }) => Effect.fail(cause),
            }),
          ),
        listPayouts: <Config extends OperationConfig>(request: {
          readonly params?: PayoutsListPayoutsParams
          readonly config?: Config
        } | undefined) =>
          client.payoutsListPayouts(request).pipe(
            Effect.catchTags({
              PayoutsListPayouts400: ({ cause }) => Effect.fail(cause),
              PayoutsListPayouts401: ({ cause }) => Effect.fail(cause),
              PayoutsListPayouts409: ({ cause }) => Effect.fail(cause),
            }),
          ),
        getPayout: <Config extends OperationConfig>(payoutId: string, request?: { readonly config?: Config }) =>
          client.payoutsGetPayout(payoutId, request).pipe(
            Effect.catchTags({
              PayoutsGetPayout400: ({ cause }) => Effect.fail(cause),
              PayoutsGetPayout401: ({ cause }) => Effect.fail(cause),
              PayoutsGetPayout404: ({ cause }) => Effect.fail(cause),
              PayoutsGetPayout409: ({ cause }) => Effect.fail(cause),
            }),
          ),
      }
    },
  }
}

export type Client = ReturnType<typeof createClient>

export type AuthorizedClient = ReturnType<Client["authorized"]>
