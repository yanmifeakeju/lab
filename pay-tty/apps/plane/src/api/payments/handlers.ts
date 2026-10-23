import { Payments } from "@pay-tty/core/payments"
import { Effect, Schema } from "effect"
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder"

import { api } from "../api.ts"
import { InvalidRequestError, NotFound } from "../errors.ts"
import { CurrentBusiness } from "../middleware/business.ts"
import { paymentPage } from "./routes.ts"

export const PaymentsLive = HttpApiBuilder.group(api, "payments", (handlers) =>
  handlers.handle("listPayments", ({ query }) => Effect.gen(function* () {
    const business = yield* CurrentBusiness
    const payments = yield* Payments.Service

    if (query.link_id !== undefined && !Schema.is(Payments.ID)(query.link_id)) {
      return yield* new NotFound({ message: "Payment link not found.", error: { code: "not_found" } })
    }

    const page = yield* payments.listPayments(business.id, {
      // Unknown IDs are looked up in this business and answered with 404.
      linkId: query.link_id === undefined ? null : Payments.ID.make(query.link_id),
      status: query.status ?? null,
      before: query.before ?? null,
    }).pipe(Effect.catchTags({
      "Payments.LinkNotFoundError": () => new NotFound({
        message: "Payment link not found.", error: { code: "not_found" },
      }),
      "Payments.CursorError": () => new InvalidRequestError({
        message: "Invalid payment cursor.",
        error: { code: "validation_error", details: [{
          location: "query", field: "before", code: "invalid_value", message: "Invalid payment cursor.",
        }] },
      }),
    }))

    return paymentPage(page)
  })),
)
