import { Effect } from "effect"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"

// A defect has no response schema, so the router would answer with a bodyless
// 500. It also carries stack traces and connection details, so it is logged
// rather than sent and the caller gets a fixed body.
export const UnknownErrorResponse = HttpRouter.middleware(
  (effect) =>
    Effect.catchDefect(effect, (defect) =>
      Effect.as(
        Effect.logError(defect),
        HttpServerResponse.jsonUnsafe(
          // The ledger API's ErrorResponse, so both services fail alike.
          {
            message: "The server could not complete the request.",
            error: { code: "internal_server_error" },
          },
          { status: 500 },
        ),
      ),
    ),
  { global: true },
)
