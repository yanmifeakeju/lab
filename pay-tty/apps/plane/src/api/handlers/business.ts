import { Business } from "@pay-tty/core/business";
import { Effect } from "effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { BusinessLedger } from "../../ledger/business-ledger.ts";
import {
  BadGateway,
  Conflict,
  NotFound,
  ServiceUnavailable,
} from "../errors.ts";
import { CurrentPrincipal } from "../principal.ts";
import { businessInfo } from "../routes/business.ts";
import { api } from "../routes/index.ts";

// Fixed messages: the reasons carry account refs and upstream detail, so
// they are logged, not sent.
const conflict = new Conflict({
  message: "The business's recorded ledger state conflicts with this request.",
  error: { code: "conflict" },
});

const rejected = new Conflict({
  message: "The ledger refused the account for this business.",
  error: { code: "ledger_rejected" },
});

export const BusinessLive = HttpApiBuilder.group(
  api,
  "business",
  (handlers) =>
    handlers
      // Records the business in its country's default ledger and links it to
      // the caller, nothing more. A principal that already has one gets it back
      // unchanged.
      .handle("createBusiness", ({ payload }) =>
        Effect.gen(function* () {
          const businesses = yield* Business.Service;
          const principal = yield* CurrentPrincipal.Service;

          const business = yield* businesses
            .create(
              principal.id,
              new Business.Details({
                name: payload.name,
                countryCode: payload.country_code,
              }),
            )
            .pipe(
              Effect.catchTag("Business.CountryUnavailableError", (error) =>
                Effect.logWarning("business not created", error).pipe(
                  Effect.andThen(
                    new ServiceUnavailable({
                      message:
                        "Businesses can't be created in this country yet.",
                      error: { code: "country_unavailable" },
                    }),
                  ),
                )),
            );

          return businessInfo(business);
        }))
      .handle("createBusinessLedger", ({ params }) =>
        Effect.gen(function* () {
          const ledgers = yield* BusinessLedger.Service;
          const principal = yield* CurrentPrincipal.Service;

          const business = yield* ledgers.create(
            principal.id,
            params.businessId,
          ).pipe(
            Effect.tapError((error) =>
              Effect.logWarning("business ledger not created", error)
            ),
            Effect.catchTags({
              "BusinessLedger.NotFoundError": () =>
                new NotFound({
                  message: "No such business.",
                  error: { code: "not_found" },
                }),
              "BusinessLedger.ConflictError": () => conflict,
              "BusinessLedger.RejectedError": () => rejected,
              "BusinessLedger.BadResponseError": () =>
                new BadGateway({
                  message:
                    "The ledger returned a response that could not be used.",
                  error: { code: "ledger_bad_response" },
                }),
              "BusinessLedger.UnavailableError": () =>
                new ServiceUnavailable({
                  message: "The ledger is unavailable. Try again.",
                  error: { code: "ledger_unavailable" },
                }),
            }),
          );

          return businessInfo(business);
        })),
);
