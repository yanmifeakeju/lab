import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware"
import * as HttpApiSecurity from "effect/unstable/httpapi/HttpApiSecurity"

import { CurrentPrincipal } from "../principal.ts"
import { InvalidRequestError, Unauthorized } from "../errors.ts"

// What each middleware may fail with and provide, as the routes and OpenAPI
// see it; the implementations are in ../middleware/.

// Verifies the caller's bearer token and provides the principal it names to
// the handler, one request at a time.
export class Authentication extends HttpApiMiddleware.Service<
  Authentication,
  { provides: CurrentPrincipal.Service }
>()("Authentication", {
  error: Unauthorized,
  security: { bearer: HttpApiSecurity.bearer },
}) {}

// Declared on the whole API so a request that fails its schema is answered as
// a 400 the client can read, not a defect.
export class SchemaErrorMiddleware extends HttpApiMiddleware.Service<SchemaErrorMiddleware>()(
  "SchemaErrorMiddleware",
  { error: InvalidRequestError },
) {}
