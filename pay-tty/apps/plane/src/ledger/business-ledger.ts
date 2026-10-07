import { Business } from "@pay-tty/core/business";
import { Catalog } from "@pay-tty/core/catalog";
import { Database } from "@pay-tty/core/database";
import { Ledger } from "@pay-tty/core/ledger";
import type { Principal } from "@pay-tty/core/principal";
import type { ApiErrorResponse } from "@pay-tty/ledger-client";
import { Context, Effect, Layer, Result, Schema } from "effect";
import * as HttpClientError from "effect/unstable/http/HttpClientError";

import { LedgerClient } from "./client.ts";

// Every business is NGN, and NGN businesses hold their account in this ledger.
// A fixed pair, so a retry always asks for the same account.
const currency = "NGN";

const ledger = Ledger.ngn;

export class NotFoundError extends Schema.TaggedError<NotFoundError>()(
  "BusinessLedger.NotFoundError",
  {},
) {}

/** The business's recorded state rules the request out. */
export class ConflictError extends Schema.TaggedError<ConflictError>()(
  "BusinessLedger.ConflictError",
  { reason: Schema.String },
) {}

/** The ledger refused the account, or returned one that is closed. */
export class RejectedError extends Schema.TaggedError<RejectedError>()(
  "BusinessLedger.RejectedError",
  { reason: Schema.String },
) {}

/** The ledger couldn't be reached or failed on its side. */
export class UnavailableError extends Schema.TaggedError<UnavailableError>()(
  "BusinessLedger.UnavailableError",
  {},
) {}

/** The ledger's answer is malformed or isn't the account asked for. */
export class BadResponseError extends Schema.TaggedError<BadResponseError>()(
  "BusinessLedger.BadResponseError",
  { reason: Schema.String },
) {}

export type Error =
  | NotFoundError
  | ConflictError
  | RejectedError
  | UnavailableError
  | BadResponseError;

export interface Interface {
  /**
   * Opens the business's payable account in its NGN ledger, records it as the
   * default, and activates the business. Repeating it returns the business as
   * it is; a failure leaves it created, with nothing recorded.
   */
  readonly create: (
    principalId: Principal.ID,
    businessId: string,
  ) => Effect.Effect<Business.Info, Error>;
}

export class Service
  extends Context.Service<Service, Interface>()("BusinessLedger") {}

type LedgerFailure =
  | ApiErrorResponse
  | HttpClientError.HttpClientError
  | Schema.SchemaError;

// Transport failures and the ledger's own 500s are worth retrying as-is. A
// 400 means plane sent what the ledger won't take, an answer that isn't the
// JSON promised is plane's to chase, and anything else is the ledger refusing
// this business.
const classify = (failure: LedgerFailure) => {
  if (HttpClientError.isHttpClientError(failure)) {
    // The client reports an unparsable or missing body as an HTTP error too,
    // but the ledger did answer.
    return failure.reason instanceof HttpClientError.DecodeError ||
        failure.reason instanceof HttpClientError.EmptyBodyError
      ? new BadResponseError({ reason: failure.reason.message })
      : new UnavailableError();
  }

  if (Schema.isSchemaError(failure)) {
    return new BadResponseError({ reason: failure.message });
  }

  switch (failure.error.code) {
    case "internal_server_error":
      return new UnavailableError();
    case "validation_error":
      return new BadResponseError({ reason: failure.message });
    default:
      return new RejectedError({ reason: failure.error.code });
  }
};

const make = Effect.gen(function* () {
  const businesses = yield* Business.Service;
  const catalog = yield* Catalog.Service;
  const client = yield* LedgerClient.Service;
  const database = yield* Database;

  const create = Effect.fn("BusinessLedger.create")(
    function* (principalId: Principal.ID, businessId: string) {
      const business = yield* businesses.findByPrincipal(principalId);

      if (business === undefined || business.id !== businessId) {
        return yield* new NotFoundError();
      }

      // Checked before anything is returned, active or not: this endpoint
      // only ever means NGN in ngn_ng, and never switches a default.
      if (business.currencyCode !== currency) {
        return yield* new ConflictError({
          reason: `business currency is ${business.currencyCode}`,
        });
      }

      if (business.ledger !== null && business.ledger.slug !== ledger) {
        return yield* new ConflictError({
          reason: `business already defaults to ${business.ledger.slug}`,
        });
      }

      if (business.status === "active") {
        return business;
      }

      // Recorded before an interruption: finish without asking the ledger.
      if (business.ledger !== null) {
        return yield* businesses.activate(business.id);
      }

      // The catalog is seeded with the ledger; without it, or in another
      // currency, nothing can be recorded, so the ledger isn't asked.
      const target = yield* catalog.find(ledger);

      if (target === undefined || target.currency !== currency) {
        return yield* Effect.die(
          new Error(`catalog has no ${currency} ledger ${ledger}`),
        );
      }

      const created = yield* Effect.result(
        client.createPayableAccount({
          payload: { ledger, external_id: business.id, name: business.name },
        }),
      );

      if (Result.isFailure(created)) {
        const error = classify(created.failure);

        yield* Effect.logWarning(
          "ledger account creation failed",
          created.failure,
        ).pipe(
          Effect.annotateLogs({ businessId: business.id }),
        );

        return yield* error;
      }

      const account = created.success;

      if (
        account.ledger_slug !== ledger || account.external_id !== business.id ||
        account.name !== business.name
      ) {
        return yield* new BadResponseError({
          reason:
            `ledger returned ${account.ledger_slug}/${account.external_id} for ${ledger}/${business.id}`,
        });
      }

      if (account.status !== "open" || account.closed_at !== null) {
        return yield* new RejectedError({ reason: "account_closed" });
      }

      // Opened only once the ledger has answered, so no transaction waits on
      // it. The holder, default account, and activation commit together.
      return yield* database
        .transaction(
          Effect.gen(function* () {
            yield* businesses.recordPayableAccount(
              business.id,
              ledger,
              new Business.PayableAccount({
                holderRef: account.holder_reference,
                accountRef: account.reference,
              }),
              { isDefault: true },
            );

            return yield* businesses.activate(business.id);
          }),
        )
        .pipe(
          Effect.catchTag(
            "Business.ConflictError",
            (conflict) => new ConflictError({ reason: conflict.message }),
          ),
        );
    },
    // The business was found above, so a missing one is a bug.
    Effect.catchTag("Business.NotFoundError", Effect.die),
  );

  return Service.of({ create });
});

export const layer = Layer.effect(Service)(make);

export * as BusinessLedger from "./business-ledger.ts";
