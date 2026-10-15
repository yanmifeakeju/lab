import { Business } from "@pay-tty/core/business";
import { Effect } from "effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { Conflict, ServiceUnavailable } from "../errors.ts";
import { CurrentPrincipal } from "../principal.ts";
import { api } from "../api.ts";
import { businessInfo } from "./routes.ts";

export const BusinessLive = HttpApiBuilder.group(
  api,
  "business",
  (handlers) =>
    handlers
      // Records the business in its country's default ledger and links it to
      // the caller, nothing more. A principal that already has one gets it back
      // unchanged for the same name and country, and a conflict otherwise.
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
              Effect.tapError((error) =>
                Effect.logWarning("business not created", error)
              ),
              Effect.catchTags({
                "Business.CountryUnavailableError": () =>
                  new ServiceUnavailable({
                    message: "Businesses can't be created in this country yet.",
                    error: { code: "country_unavailable" },
                  }),
                "Business.ConflictError": () =>
                  new Conflict({
                    message:
                      "This account already has a business with a different name or country.",
                    error: { code: "conflict" },
                  }),
              }),
            );

          return businessInfo(business);
        })),
);
