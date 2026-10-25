import { Payments } from "@pay-tty/core/payments"
import { Effect, Match } from "effect"
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder"

import { api } from "../api.ts"
import { Conflict, InvalidRequestError, NotFound, ValidationError, ValidationErrorDetail } from "../errors.ts"
import { payableLink, payment } from "./routes.ts"

const linkNotFound = () =>
  new NotFound({ message: "No payment link has this token.", error: { code: "not_found" } })

// Only the link knows whether it takes an amount, so this is checked after
// the request decoded, and answered like any other invalid field.
const invalidAmount = (error: Payments.AmountError) =>
  new InvalidRequestError({
    message: "The request is invalid.",
    error: new ValidationError({
      code: "validation_error",
      details: [
        new ValidationErrorDetail({
          location: "body",
          field: "amount",
          code: Match.value(error.reason).pipe(
            Match.when("required", () => "required" as const),
            Match.when("unexpected", () => "unknown_field" as const),
            Match.orElse(() => "invalid_value" as const),
          ),
          message: error.message,
        }),
      ],
    }),
  })

const closed = ({ payment: ended }: Payments.PaymentClosedError) =>
  ended.status === "expired"
    ? new Conflict({ message: "This payment expired.", error: { code: "payment_expired" } })
    : new Conflict({ message: "This payment has already ended.", error: { code: "not_pending" } })

export const PayLive = HttpApiBuilder.group(api, "pay", (handlers) =>
  handlers
    .handle("paymentLink", ({ params }) =>
      Effect.gen(function* () {
        const payments = yield* Payments.Service

        return payableLink(
          yield* payments.findLink(params.share_token).pipe(
            Effect.catchTag("Payments.LinkNotFoundError", () => Effect.fail(linkNotFound())),
          ),
        )
      }),
    )
    .handle("startPayment", ({ params, headers, payload }) =>
      Effect.gen(function* () {
        const payments = yield* Payments.Service

        const amount = payload.amount == null ? null : BigInt(payload.amount)

        const started = yield* payments
          .startPayment(params.share_token, headers["idempotency-key"], amount)
          .pipe(
            Effect.catchTags({
              "Payments.LinkNotFoundError": () => Effect.fail(linkNotFound()),
              "Payments.LinkInactiveError": () =>
                new Conflict({
                  message: "This link is no longer accepting payments.",
                  error: { code: "link_inactive" },
                }),
              "Payments.AmountError": (error) => Effect.fail(invalidAmount(error)),
              "Payments.PaymentConflictError": () =>
                new Conflict({
                  message: "This idempotency key already started a different payment.",
                  error: { code: "conflict" },
                }),
            }),
          )

        return payment(started.payment, started.created)
      }),
    )
    .handle("simulatePayment", ({ params, payload }) =>
      Effect.gen(function* () {
        const payments = yield* Payments.Service

        const ended = yield* payments.simulate(params.share_token, params.payment_id, payload.outcome).pipe(
          Effect.catchTags({
            "Payments.LinkNotFoundError": () => Effect.fail(linkNotFound()),
            "Payments.PaymentNotFoundError": () =>
              new NotFound({ message: "This link has no such payment.", error: { code: "not_found" } }),
            "Payments.PaymentClosedError": (error) => Effect.fail(closed(error)),
          }),
        )

        return payment(ended)
      }),
    ),
)
