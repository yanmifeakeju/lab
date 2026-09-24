import { Effect, Match, SchemaIssue } from "effect"
import type * as HttpApiError from "effect/unstable/httpapi/HttpApiError"
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware"

import {
  InvalidRequestError,
  type Location,
  SchemaErrorMiddleware,
  ValidationError,
  ValidationErrorDetail,
  type DetailCode,
} from "../api/errors.ts"

const formatIssue = SchemaIssue.makeFormatterDefault()

const locations: Record<HttpApiError.HttpApiSchemaError["kind"], Location> = {
  Payload: "body",
  Body: "body",
  Params: "path",
  Query: "query",
  Headers: "header",
  ResponseHeaders: "request",
}

const filterCodes = new Map<string, DetailCode>([
  ["effect/schema/isMinLength", "min_length"],
  ["effect/schema/isMaxLength", "max_length"],
  ["effect/schema/isPattern", "invalid_format"],
])

// Flattens the issue tree into one detail per failing field, keeping the path
// that Pointer nodes carry down to each leaf.
const details = (
  issue: SchemaIssue.Issue,
  location: Location,
  path: ReadonlyArray<PropertyKey>,
): Array<ValidationErrorDetail> => {
  const field = path.length === 0 ? location : path.map(String).join(".")

  const detail = (code: DetailCode, message: string) => [
    new ValidationErrorDetail({ location, field, code, message }),
  ]

  return Match.value(issue).pipe(
    Match.tagsExhaustive({
      Pointer: (pointer) => details(pointer.issue, location, [...path, ...pointer.path]),
      Composite: (composite) =>
        composite.issues.flatMap((inner) => details(inner, location, path)),
      Encoding: (encoding) => details(encoding.issue, location, path),
      MissingKey: () => detail("required", `${field} is required`),
      UnexpectedKey: () => detail("unknown_field", `${field} is not allowed`),
      InvalidType: (leaf) => detail("invalid_type", formatIssue(leaf)),
      Filter: (filter) =>
        detail(
          filterCodes.get(String(filter.filter.annotations?.["representation"]?.id)) ??
            "invalid_value",
          formatIssue(filter),
        ),
      // HttpApi decodes a payload as the union of the endpoint's payload
      // schemas; an AnyOf with no member issues means no member's type fit.
      AnyOf: (anyOf) =>
        anyOf.issues.length === 0
          ? detail("invalid_type", formatIssue(anyOf))
          : anyOf.issues.flatMap((inner) => details(inner, location, path)),
      OneOf: (leaf) => detail("invalid_value", formatIssue(leaf)),
      // Unwrapped only when the body itself failed to parse as JSON; a failed
      // check reaches its InvalidValue through Filter.
      InvalidValue: (leaf) =>
        detail(path.length === 0 ? "invalid_format" : "invalid_value", formatIssue(leaf)),
      Forbidden: (leaf) => detail("invalid_value", formatIssue(leaf)),
    }),
  )
}

export const SchemaErrorLive = HttpApiMiddleware.layerSchemaErrorTransform(
  SchemaErrorMiddleware,
  (error) => {
    const [first, ...rest] = details(error.cause.issue, locations[error.kind], [])

    const found = first ?? new ValidationErrorDetail({
      location: locations[error.kind],
      field: locations[error.kind],
      code: "invalid_value",
      message: error.cause.message,
    })

    return Effect.logWarning("request rejected by schema").pipe(
      Effect.annotateLogs({ kind: error.kind, reason: error.cause.message }),
      Effect.andThen(
        Effect.fail(
          new InvalidRequestError({
            message: "Request validation failed.",
            error: new ValidationError({ code: "validation_error", details: [found, ...rest] }),
          }),
        ),
      ),
    )
  },
)
