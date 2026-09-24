import { Schema } from "effect"
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware"

// Error bodies follow the ledger API's shapes (openapi.yaml), so a client reads
// both services' failures the same way.

export const Location = Schema.Literals(["request", "path", "query", "header", "body"])

export type Location = typeof Location.Type

export const DetailCode = Schema.Literals([
  "required",
  "invalid_type",
  "invalid_format",
  "invalid_value",
  "min_length",
  "max_length",
  "unknown_field",
])

export type DetailCode = typeof DetailCode.Type

export class ValidationErrorDetail extends Schema.Class<ValidationErrorDetail>(
  "ValidationErrorDetail",
)({
  location: Location,
  field: Schema.NonEmptyString,
  code: DetailCode,
  message: Schema.NonEmptyString,
}) {}

export class ValidationError extends Schema.Class<ValidationError>("ValidationError")({
  code: Schema.Literal("validation_error"),
  details: Schema.NonEmptyArray(ValidationErrorDetail),
}) {}

export class InvalidRequestError extends Schema.Error<InvalidRequestError>(
  "ValidationErrorResponse",
)(
  {
    message: Schema.NonEmptyString,
    error: ValidationError,
  },
  { httpApiStatus: 400 },
) {}

// Declared on the whole API so a request that fails its schema is answered as
// a 400 the client can read, not a defect.
export class SchemaErrorMiddleware extends HttpApiMiddleware.Service<SchemaErrorMiddleware>()(
  "SchemaErrorMiddleware",
  { error: InvalidRequestError },
) {}
