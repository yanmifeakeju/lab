import { Payments } from "@pay-tty/core/payments"
import { Effect } from "effect"
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder"

import { Conflict } from "../errors.ts"
import { CurrentBusiness } from "../middleware/business.ts"
import { api } from "../api.ts"
import { bounds, paymentLink, paymentLinkList } from "./routes.ts"

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
              ? new Payments.Fixed({ amountMinor: BigInt(pricing.amount_minor) })
              : new Payments.CustomerChooses(bounds(pricing)),
        })

        const { link, created } = yield* payments.createLink(business.id, headers["idempotency-key"], details).pipe(
          Effect.tapError((error) => Effect.logWarning("payment link not created", error)),
          Effect.catchTags({
            // The middleware found it, and a business is never deleted.
            "Business.NotFoundError": Effect.die,
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
