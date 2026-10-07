import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as HttpClientError from "effect/unstable/http/HttpClientError"
import * as Schema from "effect/Schema"

import type {
  ErrorResponse,
  ValidationErrorResponse,
} from "./generated.ts"

export type ApiErrorResponse = ErrorResponse | ValidationErrorResponse

export type ClientError =
  | ApiErrorResponse
  | Config.ConfigError
  | HttpClientError.HttpClientError
  | Schema.SchemaError

export interface ClientErrorHandlers {
  readonly onConfigError: (
    error: Config.ConfigError,
  ) => Effect.Effect<void>
  readonly onHttpClientError: (
    error: HttpClientError.HttpClientError,
  ) => Effect.Effect<void>
  readonly onSchemaError: (
    error: Schema.SchemaError,
  ) => Effect.Effect<void>
  readonly onApiError: (
    error: ApiErrorResponse,
  ) => Effect.Effect<void>
}

export const catchClientErrors = <
  A,
  Requirements,
>(
  effect: Effect.Effect<A, ClientError, Requirements>,
  handlers: ClientErrorHandlers,
) =>
  Effect.matchEffect(effect, {
    onFailure: (error) => {
      if (error instanceof Config.ConfigError) {
        return handlers.onConfigError(error)
      }

      if (HttpClientError.isHttpClientError(error)) {
        return handlers.onHttpClientError(error)
      }

      if (Schema.isSchemaError(error)) {
        return handlers.onSchemaError(error)
      }

      return handlers.onApiError(error)
    },
    onSuccess: Effect.succeed,
  })
