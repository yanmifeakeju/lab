import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint"
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup"

import { BusinessInfo } from "../business/routes.ts"
import { BadGateway, Conflict, ServiceUnavailable } from "../errors.ts"
import { Authentication } from "../middleware/authentication.ts"
import { BusinessContext } from "../middleware/business.ts"

export const account = HttpApiGroup.make("account")
  .add(
    // No body: the account opens in the ledger saved when the business was
    // created.
    HttpApiEndpoint.post("createAccount", "/account", {
      success: BusinessInfo,
      error: [Conflict, BadGateway, ServiceUnavailable],
    }),
  )
  .middleware(BusinessContext)
  .middleware(Authentication)
