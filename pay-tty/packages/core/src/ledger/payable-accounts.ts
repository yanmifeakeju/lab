import type { ApiErrorResponse } from "@pay-tty/ledger-client"
import { Context, Effect, Layer, Result, Schema } from "effect"
import * as HttpClientError from "effect/unstable/http/HttpClientError"

import { LedgerClient } from "./client.ts"
import { Ledger } from "./slug.ts"

/** The ledger refused the account, or returned one that is closed. */
export class RejectedError extends Schema.TaggedError<RejectedError>()(
  "PayableAccounts.RejectedError",
  { reason: Schema.String },
) {}

/** The ledger couldn't be reached or failed on its side. */
export class UnavailableError extends Schema.TaggedError<UnavailableError>()(
  "PayableAccounts.UnavailableError",
  {},
) {}

/** The ledger's answer is malformed or isn't the account asked for. */
export class BadResponseError extends Schema.TaggedError<BadResponseError>()(
  "PayableAccounts.BadResponseError",
  { reason: Schema.String },
) {}

export type Error = RejectedError | UnavailableError | BadResponseError

/** Who the account is for: the ledger keys it by ledger and external ID. */
export interface Holder {
  readonly ledger: Ledger.Slug
  readonly externalId: string
  readonly name: string
}

export class Account extends Schema.Class<Account>("PayableAccounts.Account")({
  holderRef: Schema.String,
  accountRef: Schema.String,
}) {}

export interface Interface {
  /**
   * Opens the holder's payable account in the ledger, or returns the one it
   * already has: a repeat is safe. The account is open and is the one asked for.
   */
  readonly open: (holder: Holder) => Effect.Effect<Account, Error>
}

export class Service extends Context.Service<Service, Interface>()("PayableAccounts") {}

type LedgerFailure =
  | ApiErrorResponse
  | HttpClientError.HttpClientError
  | Schema.SchemaError

// Transport failures and the ledger's own 500s are worth retrying as-is. An
// answer that isn't the JSON promised is ours to chase, and anything else is
// the ledger refusing this holder. A 400 means we sent what the ledger won't
// take, such as a catalog ledger it doesn't have: a defect, since the caller
// can do nothing about it.
const classify = (failure: LedgerFailure): Effect.Effect<never, Error> => {
  if (HttpClientError.isHttpClientError(failure)) {
    // The client reports an unparsable or missing body as an HTTP error too,
    // but the ledger did answer.
    return failure.reason instanceof HttpClientError.DecodeError ||
        failure.reason instanceof HttpClientError.EmptyBodyError
      ? Effect.fail(new BadResponseError({ reason: failure.reason.message }))
      : Effect.fail(new UnavailableError())
  }

  if (Schema.isSchemaError(failure)) {
    return Effect.fail(new BadResponseError({ reason: failure.message }))
  }

  switch (failure.error.code) {
    case "internal_server_error":
      return Effect.fail(new UnavailableError())
    case "validation_error":
      return Effect.die(failure)
    default:
      return Effect.fail(new RejectedError({ reason: failure.error.code }))
  }
}

const make = Effect.gen(function* () {
  const client = yield* LedgerClient.Service

  const open = Effect.fn("PayableAccounts.open")(function* (holder: Holder) {
    const { ledger, externalId, name } = holder

    const created = yield* Effect.result(
      client.createPayableAccount({ payload: { ledger, external_id: externalId, name } }),
    )

    if (Result.isFailure(created)) {
      yield* Effect.logWarning("ledger account creation failed", created.failure).pipe(
        Effect.annotateLogs({ externalId }),
      )

      return yield* classify(created.failure)
    }

    const account = created.success

    if (account.ledger_slug !== ledger || account.external_id !== externalId || account.name !== name) {
      return yield* new BadResponseError({
        reason: `ledger returned ${account.ledger_slug}/${account.external_id} for ${ledger}/${externalId}`,
      })
    }

    if (account.status !== "open" || account.closed_at !== null) {
      return yield* new RejectedError({ reason: "account_closed" })
    }

    return new Account({ holderRef: account.holder_reference, accountRef: account.reference })
  })

  return Service.of({ open })
})

export const layer = Layer.effect(Service)(make)

export * as PayableAccounts from "./payable-accounts.ts"
