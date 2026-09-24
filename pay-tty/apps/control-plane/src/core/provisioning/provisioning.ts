import type { ApiErrorResponse } from "@pay-tty/ledger-client"
import { Context, Effect, Layer, Result, Schema } from "effect"
import * as HttpClientError from "effect/unstable/http/HttpClientError"

import { Business } from "../business/business.ts"
import { LedgerClient } from "../ledger/client.ts"
import { Ledger } from "../ledger/ledger.ts"
import { Principal } from "../principal/principal.ts"

// Stored on a stalled business. Unavailable is worth retrying as-is; rejected
// will fail the same way until something on our side changes.
export const failureCodes = {
  ledgerUnavailable: "ledger_unavailable",
  ledgerRejected: "ledger_rejected",
} as const

export interface Interface {
  /**
   * Registers the principal's business, resuming one already in progress. A
   * step that fails stalls the business rather than failing the call.
   */
  readonly register: (
    identity: Principal.Identity,
    details: Business.Details,
  ) => Effect.Effect<Business.Info>
}

export class Service extends Context.Service<Service, Interface>()("Provisioning") {}

type LedgerFailure =
  | ApiErrorResponse
  | HttpClientError.HttpClientError
  | Schema.SchemaError

const ledgerFailure = (error: LedgerFailure) => {
  // Transport failures and the ledger's own 500s are transient; a validation
  // error, holder conflict, closed ledger, or undecodable response is not.
  const transient =
    HttpClientError.isHttpClientError(error) ||
    (!Schema.isSchemaError(error) && error.error.code === "internal_server_error")

  return new Business.Failure({
    code: transient ? failureCodes.ledgerUnavailable : failureCodes.ledgerRejected,
    message: "The ledger account could not be initialized.",
  })
}

const make = Effect.gen(function* () {
  const principals = yield* Principal.Service
  const businesses = yield* Business.Service
  const client = yield* LedgerClient.Service

  // Returns the business as the step leaves it: stalled, or ready for the
  // next step once it holds a payable account in its default ledger.
  const provisionLedger = Effect.fnUntraced(function* (business: Business.Info) {
    if (
      (yield* businesses.payableAccount(business.id, business.defaultLedger)) !==
      undefined
    ) {
      return business
    }

    const created = yield* Effect.result(
      client.createPayableAccount({
        payload: {
          ledger: business.defaultLedger,
          external_id: business.id,
          name: business.name,
        },
      }),
    )

    if (Result.isFailure(created)) {
      yield* Effect.logError("ledger provisioning failed", created.failure).pipe(
        Effect.annotateLogs({ businessId: business.id }),
      )

      return yield* businesses.stall(
        business.id,
        "ledger",
        ledgerFailure(created.failure),
      )
    }

    yield* businesses.recordPayableAccount(
      business.id,
      business.defaultLedger,
      new Business.PayableAccount({
        holderRef: created.success.holder_reference,
        accountRef: created.success.reference,
      }),
    )

    return yield* businesses.advance(business.id, "workspace")
  })

  const register = Effect.fn("Provisioning.register")(
    function* (identity: Principal.Identity, details: Business.Details) {
      const principal = yield* principals.ensure(identity)
      // Registration doesn't ask for a currency, so every business starts in
      // the NGN ledger.
      const business = yield* businesses.create(principal.id, details, Ledger.ngn)

      if (business.provisioningStatus === "active") {
        return business
      }

      const ledgered = yield* provisionLedger(business)

      if (ledgered.provisioningStatus === "stalled") {
        return ledgered
      }

      // The workspace step is deferred until Turso lands.
      return yield* businesses.activate(business.id)
    },
    // The business was created above, so a missing one is a bug.
    Effect.orDie,
  )

  return Service.of({ register })
})

export const layer = Layer.effect(Service)(make)

export * as Provisioning from "./provisioning.ts"
