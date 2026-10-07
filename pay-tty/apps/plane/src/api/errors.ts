import { Schema } from "effect"

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

export class Unauthorized extends Schema.Error<Unauthorized>("UnauthorizedResponse")(
  {
    message: Schema.NonEmptyString,
    error: Schema.Struct({ code: Schema.Literal("unauthorized") }),
  },
  { httpApiStatus: 401 },
) {}

export const unauthorized = new Unauthorized({
  message: "A valid access token is required.",
  error: { code: "unauthorized" },
})

export class Forbidden extends Schema.Error<Forbidden>("ForbiddenResponse")(
  {
    message: Schema.NonEmptyString,
    error: Schema.Struct({ code: Schema.Literal("forbidden") }),
  },
  { httpApiStatus: 403 },
) {}

// The caller has no business with this ID; one owned by someone else is
// answered the same way, so it can't be told apart.
export class NotFound extends Schema.Error<NotFound>("NotFoundResponse")(
  {
    message: Schema.NonEmptyString,
    error: Schema.Struct({ code: Schema.Literal("not_found") }),
  },
  { httpApiStatus: 404 },
) {}

export class Conflict extends Schema.Error<Conflict>("ConflictResponse")(
  {
    message: Schema.NonEmptyString,
    error: Schema.Struct({ code: Schema.Literals(["conflict", "ledger_rejected"]) }),
  },
  { httpApiStatus: 409 },
) {}

// The ledger answered with something plane can't use.
export class BadGateway extends Schema.Error<BadGateway>("BadGatewayResponse")(
  {
    message: Schema.NonEmptyString,
    error: Schema.Struct({ code: Schema.Literal("ledger_bad_response") }),
  },
  { httpApiStatus: 502 },
) {}

// The ledger couldn't be reached or failed on its side; retrying is safe.
export class ServiceUnavailable extends Schema.Error<ServiceUnavailable>("ServiceUnavailableResponse")(
  {
    message: Schema.NonEmptyString,
    error: Schema.Struct({ code: Schema.Literal("ledger_unavailable") }),
  },
  { httpApiStatus: 503 },
) {}
