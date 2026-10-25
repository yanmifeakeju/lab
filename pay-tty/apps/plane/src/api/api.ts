import * as HttpApi from "effect/unstable/httpapi/HttpApi"
import * as OpenApi from "effect/unstable/httpapi/OpenApi"

import { business } from "./business/routes.ts"
import { health } from "./health/routes.ts"
import { me } from "./me/routes.ts"
import { SchemaErrorMiddleware } from "./middleware/schema-error.ts"
import { pay } from "./pay/routes.ts"
import { paymentLinks } from "./payment_links/routes.ts"
import { payments } from "./payments/routes.ts"
import { session } from "./session/routes.ts"

export const api = HttpApi.make("plane")
  .add(health)
  .add(session)
  .add(me)
  .add(business)
  .add(paymentLinks)
  .add(payments)
  .add(pay)
  .middleware(SchemaErrorMiddleware)
  .annotate(OpenApi.Title, "Plane")
  // Report every failing field rather than the first, like the ledger API.
  // Unknown fields are dropped, not rejected: these options also apply when
  // encoding responses, where "error" would reject the error class's own
  // runtime properties.
  .annotate(HttpApi.ParseOptions, { errors: "all" })
