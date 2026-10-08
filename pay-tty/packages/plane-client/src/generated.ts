import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import type { SchemaError } from "effect/Schema"
import * as Schema from "effect/Schema"
import type * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientError from "effect/unstable/http/HttpClientError"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
// non-recursive definitions
export type HealthEncoded = { readonly "status": "ok" }
export const HealthEncoded = Schema.Struct({ "status": Schema.Literal("ok") }).annotate({ "identifier": "HealthEncoded" })
export type ValidationErrorDetailEncoded = { readonly "location": "request" | "path" | "query" | "header" | "body", readonly "field": string, readonly "code": "required" | "invalid_type" | "invalid_format" | "invalid_value" | "min_length" | "max_length" | "unknown_field", readonly "message": string }
export const ValidationErrorDetailEncoded = Schema.Struct({ "location": Schema.Literals(["request", "path", "query", "header", "body"]), "field": Schema.String.check(Schema.isMinLength(1).annotate({ "expected": "a value with a length of at least 1" })), "code": Schema.Literals(["required", "invalid_type", "invalid_format", "invalid_value", "min_length", "max_length", "unknown_field"]), "message": Schema.String.check(Schema.isMinLength(1).annotate({ "expected": "a value with a length of at least 1" })) }).annotate({ "identifier": "ValidationErrorDetailEncoded" })
export type SessionRequestEncoded = { readonly "issuer": string, readonly "sub": string }
export const SessionRequestEncoded = Schema.Struct({ "issuer": Schema.String.check(Schema.isMinLength(1).annotate({ "expected": "a value with a length of at least 1" })).check(Schema.isMaxLength(64).annotate({ "expected": "a value with a length of at most 64" })), "sub": Schema.String.check(Schema.isMinLength(1).annotate({ "expected": "a value with a length of at least 1" })).check(Schema.isMaxLength(255).annotate({ "expected": "a value with a length of at most 255" })).check(Schema.isPattern(new RegExp(".*\\S.*")).annotate({ "expected": "a string matching the RegExp .*\\S.*" })) }).annotate({ "identifier": "SessionRequestEncoded" })
export type SessionResponseEncoded = { readonly "accessToken": string, readonly "tokenType": "Bearer", readonly "expiresIn": number }
export const SessionResponseEncoded = Schema.Struct({ "accessToken": Schema.String, "tokenType": Schema.Literal("Bearer"), "expiresIn": Schema.Number.check(Schema.isInt().annotate({ "expected": "an integer" })) }).annotate({ "identifier": "SessionResponseEncoded" })
export type ForbiddenResponseEncoded = { readonly "message": string, readonly "error": { readonly "code": "forbidden" } }
export const ForbiddenResponseEncoded = Schema.Struct({ "message": Schema.String.check(Schema.isMinLength(1).annotate({ "expected": "a value with a length of at least 1" })), "error": Schema.Struct({ "code": Schema.Literal("forbidden") }) }).annotate({ "identifier": "ForbiddenResponseEncoded" })
export type BusinessLedgerEncoded = { readonly "slug": string, readonly "currency": string, readonly "scale": number, readonly "payable_account_ref": string }
export const BusinessLedgerEncoded = Schema.Struct({ "slug": Schema.String, "currency": Schema.String, "scale": Schema.Number.check(Schema.isInt().annotate({ "expected": "an integer" })), "payable_account_ref": Schema.String }).annotate({ "identifier": "BusinessLedgerEncoded" })
export type UnauthorizedResponseEncoded = { readonly "message": string, readonly "error": { readonly "code": "unauthorized" } }
export const UnauthorizedResponseEncoded = Schema.Struct({ "message": Schema.String.check(Schema.isMinLength(1).annotate({ "expected": "a value with a length of at least 1" })), "error": Schema.Struct({ "code": Schema.Literal("unauthorized") }) }).annotate({ "identifier": "UnauthorizedResponseEncoded" })
export type CreateBusinessRequestEncoded = { readonly "name": string, readonly "country_code"?: "NG" | "US" }
export const CreateBusinessRequestEncoded = Schema.Struct({ "name": Schema.String.check(Schema.isPattern(new RegExp(".*\\S.*")).annotate({ "expected": "a string matching the RegExp .*\\S.*" })), "country_code": Schema.optionalKey(Schema.Literals(["NG", "US"]).annotate({ "default": "NG" })) }).annotate({ "identifier": "CreateBusinessRequestEncoded" })
export type ConflictResponseEncoded = { readonly "message": string, readonly "error": { readonly "code": "conflict" | "ledger_rejected" } }
export const ConflictResponseEncoded = Schema.Struct({ "message": Schema.String.check(Schema.isMinLength(1).annotate({ "expected": "a value with a length of at least 1" })), "error": Schema.Struct({ "code": Schema.Literals(["conflict", "ledger_rejected"]) }) }).annotate({ "identifier": "ConflictResponseEncoded" })
export type ServiceUnavailableResponseEncoded = { readonly "message": string, readonly "error": { readonly "code": "ledger_unavailable" | "country_unavailable" } }
export const ServiceUnavailableResponseEncoded = Schema.Struct({ "message": Schema.String.check(Schema.isMinLength(1).annotate({ "expected": "a value with a length of at least 1" })), "error": Schema.Struct({ "code": Schema.Literals(["ledger_unavailable", "country_unavailable"]) }) }).annotate({ "identifier": "ServiceUnavailableResponseEncoded" })
export type NotFoundResponseEncoded = { readonly "message": string, readonly "error": { readonly "code": "not_found" } }
export const NotFoundResponseEncoded = Schema.Struct({ "message": Schema.String.check(Schema.isMinLength(1).annotate({ "expected": "a value with a length of at least 1" })), "error": Schema.Struct({ "code": Schema.Literal("not_found") }) }).annotate({ "identifier": "NotFoundResponseEncoded" })
export type BadGatewayResponseEncoded = { readonly "message": string, readonly "error": { readonly "code": "ledger_bad_response" } }
export const BadGatewayResponseEncoded = Schema.Struct({ "message": Schema.String.check(Schema.isMinLength(1).annotate({ "expected": "a value with a length of at least 1" })), "error": Schema.Struct({ "code": Schema.Literal("ledger_bad_response") }) }).annotate({ "identifier": "BadGatewayResponseEncoded" })
export type ValidationErrorEncoded = { readonly "code": "validation_error", readonly "details": readonly [ValidationErrorDetailEncoded, ...Array<ValidationErrorDetailEncoded>] }
export const ValidationErrorEncoded = Schema.Struct({ "code": Schema.Literal("validation_error"), "details": Schema.TupleWithRest(Schema.Tuple([ValidationErrorDetailEncoded]), [ValidationErrorDetailEncoded]) }).annotate({ "identifier": "ValidationErrorEncoded" })
export type BusinessInfoEncoded = { readonly "id": string, readonly "name": string, readonly "country_code": "NG" | "US", readonly "currency_code": string, readonly "holder_ref": string | null, readonly "status": "created" | "active", readonly "ledger": BusinessLedgerEncoded | null, readonly "created_at": string, readonly "updated_at": string }
export const BusinessInfoEncoded = Schema.Struct({ "id": Schema.String, "name": Schema.String, "country_code": Schema.Literals(["NG", "US"]), "currency_code": Schema.String, "holder_ref": Schema.Union([Schema.String, Schema.Null]), "status": Schema.Literals(["created", "active"]), "ledger": Schema.Union([BusinessLedgerEncoded, Schema.Null]), "created_at": Schema.String, "updated_at": Schema.String }).annotate({ "identifier": "BusinessInfoEncoded" })
export type ValidationErrorResponseEncoded = { readonly "message": string, readonly "error": ValidationErrorEncoded }
export const ValidationErrorResponseEncoded = Schema.Struct({ "message": Schema.String.check(Schema.isMinLength(1).annotate({ "expected": "a value with a length of at least 1" })), "error": ValidationErrorEncoded }).annotate({ "identifier": "ValidationErrorResponseEncoded" })
export type MeResponseEncoded = { readonly "id": string, readonly "created_at": string, readonly "business": BusinessInfoEncoded | null }
export const MeResponseEncoded = Schema.Struct({ "id": Schema.String, "created_at": Schema.String, "business": Schema.Union([BusinessInfoEncoded, Schema.Null]) }).annotate({ "identifier": "MeResponseEncoded" })
// schemas
export type HealthGetHealth200 = HealthEncoded
export const HealthGetHealth200 = HealthEncoded
export type HealthGetHealth400 = ValidationErrorResponseEncoded
export const HealthGetHealth400 = ValidationErrorResponseEncoded
export type SessionCreateSessionRequestJson = SessionRequestEncoded
export const SessionCreateSessionRequestJson = SessionRequestEncoded
export type SessionCreateSession200 = SessionResponseEncoded
export const SessionCreateSession200 = SessionResponseEncoded
export type SessionCreateSession400 = ValidationErrorResponseEncoded
export const SessionCreateSession400 = ValidationErrorResponseEncoded
export type SessionCreateSession403 = ForbiddenResponseEncoded
export const SessionCreateSession403 = ForbiddenResponseEncoded
export type MeMe200 = MeResponseEncoded
export const MeMe200 = MeResponseEncoded
export type MeMe400 = ValidationErrorResponseEncoded
export const MeMe400 = ValidationErrorResponseEncoded
export type MeMe401 = UnauthorizedResponseEncoded
export const MeMe401 = UnauthorizedResponseEncoded
export type BusinessCreateBusinessRequestJson = CreateBusinessRequestEncoded
export const BusinessCreateBusinessRequestJson = CreateBusinessRequestEncoded
export type BusinessCreateBusiness200 = BusinessInfoEncoded
export const BusinessCreateBusiness200 = BusinessInfoEncoded
export type BusinessCreateBusiness400 = ValidationErrorResponseEncoded
export const BusinessCreateBusiness400 = ValidationErrorResponseEncoded
export type BusinessCreateBusiness401 = UnauthorizedResponseEncoded
export const BusinessCreateBusiness401 = UnauthorizedResponseEncoded
export type BusinessCreateBusiness409 = ConflictResponseEncoded
export const BusinessCreateBusiness409 = ConflictResponseEncoded
export type BusinessCreateBusiness503 = ServiceUnavailableResponseEncoded
export const BusinessCreateBusiness503 = ServiceUnavailableResponseEncoded
export type BusinessCreateBusinessLedger200 = BusinessInfoEncoded
export const BusinessCreateBusinessLedger200 = BusinessInfoEncoded
export type BusinessCreateBusinessLedger400 = ValidationErrorResponseEncoded
export const BusinessCreateBusinessLedger400 = ValidationErrorResponseEncoded
export type BusinessCreateBusinessLedger401 = UnauthorizedResponseEncoded
export const BusinessCreateBusinessLedger401 = UnauthorizedResponseEncoded
export type BusinessCreateBusinessLedger404 = NotFoundResponseEncoded
export const BusinessCreateBusinessLedger404 = NotFoundResponseEncoded
export type BusinessCreateBusinessLedger409 = ConflictResponseEncoded
export const BusinessCreateBusinessLedger409 = ConflictResponseEncoded
export type BusinessCreateBusinessLedger502 = BadGatewayResponseEncoded
export const BusinessCreateBusinessLedger502 = BadGatewayResponseEncoded
export type BusinessCreateBusinessLedger503 = ServiceUnavailableResponseEncoded
export const BusinessCreateBusinessLedger503 = ServiceUnavailableResponseEncoded

export interface OperationConfig {
  /**
   * Whether or not the response should be included in the value returned from
   * an operation.
   *
   * If set to `true`, a tuple of `[A, HttpClientResponse]` will be returned,
   * where `A` is the success type of the operation.
   *
   * If set to `false`, only the success type of the operation will be returned.
   */
  readonly includeResponse?: boolean | undefined
}

/**
 * A utility type which optionally includes the response in the return result
 * of an operation based upon the value of the `includeResponse` configuration
 * option.
 */
export type WithOptionalResponse<A, Config extends OperationConfig> = Config extends {
  readonly includeResponse: true
} ? [A, HttpClientResponse.HttpClientResponse] : A

export const make = (
  httpClient: HttpClient.HttpClient,
  options: {
    readonly transformClient?: ((client: HttpClient.HttpClient) => Effect.Effect<HttpClient.HttpClient>) | undefined
  } = {}
): PlaneClient => {
  const unexpectedStatus = (response: HttpClientResponse.HttpClientResponse) =>
    Effect.flatMap(
      Effect.orElseSucceed(response.json, () => "Unexpected status code"),
      (description) =>
        Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.StatusCodeError({
              request: response.request,
              response,
              description: typeof description === "string" ? description : JSON.stringify(description),
            }),
          }),
        ),
    )
  const withResponse = <Config extends OperationConfig>(config: Config | undefined) => (
    f: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<any, any>,
  ): (request: HttpClientRequest.HttpClientRequest) => Effect.Effect<any, any> => {
    const withOptionalResponse = (
      config?.includeResponse
        ? (response: HttpClientResponse.HttpClientResponse) => Effect.map(f(response), (a) => [a, response])
        : (response: HttpClientResponse.HttpClientResponse) => f(response)
    ) as any
    return options?.transformClient
      ? (request) =>
          Effect.flatMap(
            Effect.flatMap(options.transformClient!(httpClient), (client) => client.execute(request)),
            withOptionalResponse
          )
      : (request) => Effect.flatMap(httpClient.execute(request), withOptionalResponse)
  }
  const __encodePathParam = encodeURIComponent
  const __makePathRequest = (
    method: (url: string) => HttpClientRequest.HttpClientRequest,
    parameters: ReadonlyArray<string>,
    getPath: () => string,
  ) => Effect.suspend(() => {
    const fail = (description: string, cause?: unknown) => Effect.fail(
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.InvalidUrlError({
          request: method(""),
          cause,
          description,
        }),
      }),
    )
    if (parameters.some((value) => value === "" || /^(?:\.|%2e){1,2}$/i.test(value))) {
      return fail("Path parameters must be non-empty and cannot be dot segments")
    }
    let path: string
    try {
      path = getPath()
    } catch (cause) {
      return fail("Failed to encode path parameter", cause)
    }
    if (path.split("/").some((segment) => /^(?:\.|%2e){1,2}$/i.test(segment))) {
      return fail("Request paths cannot contain dot segments")
    }
    return Effect.succeed(method(path))
  })
  const decodeSuccess =
    <Schema extends Schema.Constraint>(schema: Schema) =>
    (response: HttpClientResponse.HttpClientResponse) =>
      HttpClientResponse.schemaBodyJson(schema)(response)
  const decodeError =
    <const Tag extends string, Schema extends Schema.Constraint>(tag: Tag, schema: Schema) =>
    (response: HttpClientResponse.HttpClientResponse) =>
      Effect.flatMap(
        HttpClientResponse.schemaBodyJson(schema)(response),
        (cause) => Effect.fail(PlaneClientError(tag, cause, response)),
      )
  return {
    httpClient,
    "healthGetHealth": (options) => HttpClientRequest.get("/health").pipe(
      withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(HealthGetHealth200),
      "400": decodeError("HealthGetHealth400", HealthGetHealth400),
      orElse: unexpectedStatus
    }))
    ),
    "sessionCreateSession": (options) => HttpClientRequest.post("/session").pipe(
      HttpClientRequest.bodyJsonUnsafe(options.payload),
      withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(SessionCreateSession200),
      "400": decodeError("SessionCreateSession400", SessionCreateSession400),
      "403": decodeError("SessionCreateSession403", SessionCreateSession403),
      orElse: unexpectedStatus
    }))
    ),
    "meMe": (options) => HttpClientRequest.get("/me").pipe(
      withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(MeMe200),
      "400": decodeError("MeMe400", MeMe400),
      "401": decodeError("MeMe401", MeMe401),
      orElse: unexpectedStatus
    }))
    ),
    "businessCreateBusiness": (options) => HttpClientRequest.post("/business").pipe(
      HttpClientRequest.bodyJsonUnsafe(options.payload),
      withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(BusinessCreateBusiness200),
      "400": decodeError("BusinessCreateBusiness400", BusinessCreateBusiness400),
      "401": decodeError("BusinessCreateBusiness401", BusinessCreateBusiness401),
      "409": decodeError("BusinessCreateBusiness409", BusinessCreateBusiness409),
      "503": decodeError("BusinessCreateBusiness503", BusinessCreateBusiness503),
      orElse: unexpectedStatus
    }))
    ),
    "businessCreateBusinessLedger": (businessId, options) => __makePathRequest(HttpClientRequest.post, [businessId], () => "/business/" + __encodePathParam(businessId) + "/ledger").pipe(
    Effect.flatMap((request) => request.pipe(
      withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(BusinessCreateBusinessLedger200),
      "400": decodeError("BusinessCreateBusinessLedger400", BusinessCreateBusinessLedger400),
      "401": decodeError("BusinessCreateBusinessLedger401", BusinessCreateBusinessLedger401),
      "404": decodeError("BusinessCreateBusinessLedger404", BusinessCreateBusinessLedger404),
      "409": decodeError("BusinessCreateBusinessLedger409", BusinessCreateBusinessLedger409),
      "502": decodeError("BusinessCreateBusinessLedger502", BusinessCreateBusinessLedger502),
      "503": decodeError("BusinessCreateBusinessLedger503", BusinessCreateBusinessLedger503),
      orElse: unexpectedStatus
    }))
    ))
  )
  }
}

export interface PlaneClient {
  readonly httpClient: HttpClient.HttpClient
  readonly "healthGetHealth": <Config extends OperationConfig>(options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof HealthGetHealth200.Type, Config>, HttpClientError.HttpClientError | SchemaError | PlaneClientError<"HealthGetHealth400", typeof HealthGetHealth400.Type>>
  readonly "sessionCreateSession": <Config extends OperationConfig>(options: { readonly payload: typeof SessionCreateSessionRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof SessionCreateSession200.Type, Config>, HttpClientError.HttpClientError | SchemaError | PlaneClientError<"SessionCreateSession400", typeof SessionCreateSession400.Type> | PlaneClientError<"SessionCreateSession403", typeof SessionCreateSession403.Type>>
  readonly "meMe": <Config extends OperationConfig>(options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof MeMe200.Type, Config>, HttpClientError.HttpClientError | SchemaError | PlaneClientError<"MeMe400", typeof MeMe400.Type> | PlaneClientError<"MeMe401", typeof MeMe401.Type>>
  readonly "businessCreateBusiness": <Config extends OperationConfig>(options: { readonly payload: typeof BusinessCreateBusinessRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof BusinessCreateBusiness200.Type, Config>, HttpClientError.HttpClientError | SchemaError | PlaneClientError<"BusinessCreateBusiness400", typeof BusinessCreateBusiness400.Type> | PlaneClientError<"BusinessCreateBusiness401", typeof BusinessCreateBusiness401.Type> | PlaneClientError<"BusinessCreateBusiness409", typeof BusinessCreateBusiness409.Type> | PlaneClientError<"BusinessCreateBusiness503", typeof BusinessCreateBusiness503.Type>>
  readonly "businessCreateBusinessLedger": <Config extends OperationConfig>(businessId: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof BusinessCreateBusinessLedger200.Type, Config>, HttpClientError.HttpClientError | SchemaError | PlaneClientError<"BusinessCreateBusinessLedger400", typeof BusinessCreateBusinessLedger400.Type> | PlaneClientError<"BusinessCreateBusinessLedger401", typeof BusinessCreateBusinessLedger401.Type> | PlaneClientError<"BusinessCreateBusinessLedger404", typeof BusinessCreateBusinessLedger404.Type> | PlaneClientError<"BusinessCreateBusinessLedger409", typeof BusinessCreateBusinessLedger409.Type> | PlaneClientError<"BusinessCreateBusinessLedger502", typeof BusinessCreateBusinessLedger502.Type> | PlaneClientError<"BusinessCreateBusinessLedger503", typeof BusinessCreateBusinessLedger503.Type>>
}

export interface PlaneClientError<Tag extends string, E> {
  readonly _tag: Tag
  readonly request: HttpClientRequest.HttpClientRequest
  readonly response: HttpClientResponse.HttpClientResponse
  readonly cause: E
}

class PlaneClientErrorImpl extends Data.Error<{
  _tag: string
  cause: any
  request: HttpClientRequest.HttpClientRequest
  response: HttpClientResponse.HttpClientResponse
}> {}

export const PlaneClientError = <Tag extends string, E>(
  tag: Tag,
  cause: E,
  response: HttpClientResponse.HttpClientResponse,
): PlaneClientError<Tag, E> =>
  new PlaneClientErrorImpl({
    _tag: tag,
    cause,
    response,
    request: response.request,
  }) as any
