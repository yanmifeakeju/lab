import { Effect } from "effect"
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder"

import { BusinessLedger } from "../../ledger/business-ledger.ts"
import { BadGateway, Conflict, ServiceUnavailable } from "../errors.ts"
import { CurrentBusiness } from "../middleware/business.ts"
import { api } from "../api.ts"
import { businessInfo } from "../business/routes.ts"

// Fixed messages: the reasons carry account refs and upstream detail, so
// they are logged, not sent.
const conflict = new Conflict({
  message: "The business's recorded ledger state conflicts with this request.",
  error: { code: "conflict" },
})

const rejected = new Conflict({
  message: "The ledger refused the account for this business.",
  error: { code: "ledger_rejected" },
})

export const AccountLive = HttpApiBuilder.group(api, "account", (handlers) =>
  handlers.handle("createAccount", () =>
    Effect.gen(function* () {
      const ledgers = yield* BusinessLedger.Service
      const business = yield* CurrentBusiness

      const opened = yield* ledgers.create(business).pipe(
        Effect.tapError((error) => Effect.logWarning("business account not created", error)),
        Effect.catchTags({
          "BusinessLedger.ConflictError": () => conflict,
          "BusinessLedger.RejectedError": () => rejected,
          "BusinessLedger.BadResponseError": () =>
            new BadGateway({
              message: "The ledger returned a response that could not be used.",
              error: { code: "ledger_bad_response" },
            }),
          "BusinessLedger.UnavailableError": () =>
            new ServiceUnavailable({
              message: "The ledger is unavailable. Try again.",
              error: { code: "ledger_unavailable" },
            }),
        }),
      )

      return businessInfo(opened)
    }),
  ),
)
