import { Payments } from "@pay-tty/core/payments"
import { Effect } from "effect"
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder"

import { Conflict, InvalidRequestError, ValidationError, ValidationErrorDetail } from "../errors.ts"
import { CurrentBusiness } from "../middleware/business.ts"
import { api } from "../api.ts"
import { bounds, paymentLink, paymentLinkList } from "./routes.ts"

const fields = {
  amount: "pricing.amount",
  suggestedAmount: "pricing.suggested_amount",
  minimumAmount: "pricing.minimum_amount",
  maximumAmount: "pricing.maximum_amount",
} as const

// Only the business's ledger knows the least amount, so this is checked after
// the request decoded, and answered like any other invalid field.
const invalidDetails = (error: Payments.DetailsError) =>
  new InvalidRequestError({
    message: "The request is invalid.",
    error: new ValidationError({
      code: "validation_error",
      details: [
        new ValidationErrorDetail({
          location: "body",
          field: fields[error.field],
          code: "invalid_value",
          message: error.message,
        }),
      ],
    }),
  })

export const PaymentLinksLive = HttpApiBuilder.group(api, "paymentLinks", (handlers) =>
  handlers
    .handle("listPaymentLinks", () =>
      Effect.gen(function* () {
        const business = yield* CurrentBusiness
        const payments = yield* Payments.Service

        return paymentLinkList(yield* payments.listLinks(business.id))
      }),
    )
    .handle("createPaymentLink", ({ headers, payload }) =>
      Effect.gen(function* () {
        const business = yield* CurrentBusiness
        const payments = yield* Payments.Service

        const { pricing } = payload

        const details = new Payments.Details({
          title: payload.title,
          description: payload.description == null || payload.description === "" ? null : payload.description,
          pricing:
            pricing.mode === "fixed"
              ? new Payments.Fixed({ amount: BigInt(pricing.amount) })
              : new Payments.CustomerChooses(bounds(pricing)),
        })

        const { link, created } = yield* payments.createLink(business.id, headers["idempotency-key"], details).pipe(
          Effect.tapError((error) => Effect.logWarning("payment link not created", error)),
          Effect.catchTags({
            // The middleware found it, and a business is never deleted.
            "Business.NotFoundError": Effect.die,
            "Payments.DetailsError": (error) => Effect.fail(invalidDetails(error)),
            "Payments.ConflictError": () =>
              new Conflict({
                message: "This idempotency key already created a different payment link.",
                error: { code: "conflict" },
              }),
          }),
        )

        return paymentLink(link, created)
      }),
    ),
)
