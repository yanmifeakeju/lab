import { Business } from "@pay-tty/core/business";
import { Effect } from "effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { BadGateway, Conflict, ServiceUnavailable } from "../errors.ts";
import { CurrentBusiness } from "../middleware/business.ts";
import { CurrentPrincipal } from "../principal.ts";
import { api } from "../api.ts";
import { businessBalance } from "./balance.ts";
import { openAccount } from "./open-account.ts";
import { BusinessBalance, businessInfo } from "./routes.ts";

// Fixed messages: the reasons carry account refs and upstream detail, so
// they are logged, not sent.
const accountConflict = new Conflict({
  message: "The business's recorded ledger state conflicts with this request.",
  error: { code: "conflict" },
});

const accountRejected = new Conflict({
  message: "The ledger refused the account for this business.",
  error: { code: "ledger_rejected" },
});

const ledgerBadResponse = new BadGateway({
  message: "The ledger returned a response that could not be used.",
  error: { code: "ledger_bad_response" },
});

const ledgerUnavailable = new ServiceUnavailable({
  message: "The ledger is unavailable. Try again.",
  error: { code: "ledger_unavailable" },
});

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
        }))
      .handle("createAccount", () =>
        Effect.gen(function* () {
          const business = yield* CurrentBusiness;

          const opened = yield* openAccount(business).pipe(
            Effect.tapError((error) =>
              Effect.logWarning("business account not created", error)
            ),
            Effect.catchTags({
              "OpenAccount.ConflictError": () => accountConflict,
              "PayableAccounts.RejectedError": () => accountRejected,
              "PayableAccounts.BadResponseError": () => ledgerBadResponse,
              "PayableAccounts.UnavailableError": () => ledgerUnavailable,
            }),
          );

          return businessInfo(opened);
        }))
      .handle("getBalance", () =>
        Effect.gen(function* () {
          const business = yield* CurrentBusiness;

          const balance = yield* businessBalance(business).pipe(
            Effect.catchTags({
              "BusinessBalance.NotOpenedError": () =>
                new Conflict({
                  message: "Open the business's account first.",
                  error: { code: "account_not_opened" },
                }),
              // The account was recorded from the ledger's own answer, so
              // refusing to show it is a defect on one side or the other.
              "PayableAccounts.RejectedError": (error) =>
                Effect.logError("ledger refused a recorded account", error).pipe(
                  Effect.andThen(Effect.fail(ledgerBadResponse)),
                ),
              "PayableAccounts.BadResponseError": (error) =>
                Effect.logWarning("business balance not read", error).pipe(
                  Effect.andThen(Effect.fail(ledgerBadResponse)),
                ),
              "PayableAccounts.UnavailableError": () => ledgerUnavailable,
            }),
          );

          const { slug, currency, scale } = business.primaryLedger;

          return new BusinessBalance({
            ledger: slug,
            currency,
            scale,
            available: String(balance.available),
            pending: String(balance.pending),
          });
        })),
);
