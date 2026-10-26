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
export type SessionResponseEncoded = { readonly "access_token": string, readonly "token_type": "Bearer", readonly "expires_in": number }
export const SessionResponseEncoded = Schema.Struct({ "access_token": Schema.String, "token_type": Schema.Literal("Bearer"), "expires_in": Schema.Number.check(Schema.isInt().annotate({ "expected": "an integer" })) }).annotate({ "identifier": "SessionResponseEncoded" })
export type ForbiddenResponseEncoded = { readonly "message": string, readonly "error": { readonly "code": "forbidden" } }
export const ForbiddenResponseEncoded = Schema.Struct({ "message": Schema.String.check(Schema.isMinLength(1).annotate({ "expected": "a value with a length of at least 1" })), "error": Schema.Struct({ "code": Schema.Literal("forbidden") }) }).annotate({ "identifier": "ForbiddenResponseEncoded" })
export type BusinessLedgerEncoded = { readonly "slug": string, readonly "currency": string, readonly "scale": number, readonly "payable_account_ref": string }
export const BusinessLedgerEncoded = Schema.Struct({ "slug": Schema.String, "currency": Schema.String, "scale": Schema.Number.check(Schema.isInt().annotate({ "expected": "an integer" })), "payable_account_ref": Schema.String }).annotate({ "identifier": "BusinessLedgerEncoded" })
export type UnauthorizedResponseEncoded = { readonly "message": string, readonly "error": { readonly "code": "unauthorized" } }
export const UnauthorizedResponseEncoded = Schema.Struct({ "message": Schema.String.check(Schema.isMinLength(1).annotate({ "expected": "a value with a length of at least 1" })), "error": Schema.Struct({ "code": Schema.Literal("unauthorized") }) }).annotate({ "identifier": "UnauthorizedResponseEncoded" })
export type CreateBusinessRequestEncoded = { readonly "name": string, readonly "country_code"?: "NG" | "US" }
export const CreateBusinessRequestEncoded = Schema.Struct({ "name": Schema.String.check(Schema.isPattern(new RegExp(".*\\S.*")).annotate({ "expected": "a string matching the RegExp .*\\S.*" })), "country_code": Schema.optionalKey(Schema.Literals(["NG", "US"]).annotate({ "default": "NG" })) }).annotate({ "identifier": "CreateBusinessRequestEncoded" })
export type ConflictResponseEncoded = { readonly "message": string, readonly "error": { readonly "code": "conflict" | "ledger_rejected" | "business_required" | "business_inactive" | "link_inactive" | "payment_expired" | "not_pending" } }
export const ConflictResponseEncoded = Schema.Struct({ "message": Schema.String.check(Schema.isMinLength(1).annotate({ "expected": "a value with a length of at least 1" })), "error": Schema.Struct({ "code": Schema.Literals(["conflict", "ledger_rejected", "business_required", "business_inactive", "link_inactive", "payment_expired", "not_pending"]) }) }).annotate({ "identifier": "ConflictResponseEncoded" })
export type ServiceUnavailableResponseEncoded = { readonly "message": string, readonly "error": { readonly "code": "ledger_unavailable" | "country_unavailable" } }
export const ServiceUnavailableResponseEncoded = Schema.Struct({ "message": Schema.String.check(Schema.isMinLength(1).annotate({ "expected": "a value with a length of at least 1" })), "error": Schema.Struct({ "code": Schema.Literals(["ledger_unavailable", "country_unavailable"]) }) }).annotate({ "identifier": "ServiceUnavailableResponseEncoded" })
export type BadGatewayResponseEncoded = { readonly "message": string, readonly "error": { readonly "code": "ledger_bad_response" } }
export const BadGatewayResponseEncoded = Schema.Struct({ "message": Schema.String.check(Schema.isMinLength(1).annotate({ "expected": "a value with a length of at least 1" })), "error": Schema.Struct({ "code": Schema.Literal("ledger_bad_response") }) }).annotate({ "identifier": "BadGatewayResponseEncoded" })
export type FixedPricingEncoded = { readonly "mode": "fixed", readonly "amount": number }
export const FixedPricingEncoded = Schema.Struct({ "mode": Schema.Literal("fixed"), "amount": Schema.Number.annotate({ "description": "In minor units of the link's currency." }).check(Schema.isInt().annotate({ "expected": "an integer" })) }).annotate({ "identifier": "FixedPricingEncoded" })
export type CustomerChoosesPricingEncoded = { readonly "mode": "customer_chooses", readonly "suggested_amount": number | null, readonly "minimum_amount": number | null, readonly "maximum_amount": number | null }
export const CustomerChoosesPricingEncoded = Schema.Struct({ "mode": Schema.Literal("customer_chooses"), "suggested_amount": Schema.Union([Schema.Number.annotate({ "description": "In minor units of the link's currency." }).check(Schema.isInt().annotate({ "expected": "an integer" })), Schema.Null]), "minimum_amount": Schema.Union([Schema.Number.annotate({ "description": "In minor units of the link's currency." }).check(Schema.isInt().annotate({ "expected": "an integer" })), Schema.Null]), "maximum_amount": Schema.Union([Schema.Number.annotate({ "description": "In minor units of the link's currency." }).check(Schema.isInt().annotate({ "expected": "an integer" })), Schema.Null]) }).annotate({ "identifier": "CustomerChoosesPricingEncoded" })
export type PaymentStatsEncoded = { readonly "succeeded": number, readonly "failed": number, readonly "cancelled": number, readonly "expired": number, readonly "pending": number, readonly "settling": number, readonly "settled": number, readonly "attention": number, readonly "collected": string, readonly "settling_amount": string, readonly "last_paid_at": string | null }
export const PaymentStatsEncoded = Schema.Struct({ "succeeded": Schema.Number.check(Schema.isInt().annotate({ "expected": "an integer" })), "failed": Schema.Number.check(Schema.isInt().annotate({ "expected": "an integer" })), "cancelled": Schema.Number.check(Schema.isInt().annotate({ "expected": "an integer" })), "expired": Schema.Number.check(Schema.isInt().annotate({ "expected": "an integer" })), "pending": Schema.Number.check(Schema.isInt().annotate({ "expected": "an integer" })), "settling": Schema.Number.check(Schema.isInt().annotate({ "expected": "an integer" })), "settled": Schema.Number.check(Schema.isInt().annotate({ "expected": "an integer" })), "attention": Schema.Number.check(Schema.isInt().annotate({ "expected": "an integer" })), "collected": Schema.String.annotate({ "description": "In minor units of the links' currency." }).check(Schema.isPattern(new RegExp("^\\d+$")).annotate({ "expected": "a string matching the RegExp ^\\d+$" })), "settling_amount": Schema.String.annotate({ "description": "In minor units of the links' currency." }).check(Schema.isPattern(new RegExp("^\\d+$")).annotate({ "expected": "a string matching the RegExp ^\\d+$" })), "last_paid_at": Schema.Union([Schema.String, Schema.Null]) }).annotate({ "identifier": "PaymentStatsEncoded" })
export type FixedPricingRequestEncoded = { readonly "mode": "fixed", readonly "amount": number, readonly "suggested_amount"?: never, readonly "minimum_amount"?: never, readonly "maximum_amount"?: never }
export const FixedPricingRequestEncoded = Schema.Struct({ "mode": Schema.Literal("fixed"), "amount": Schema.Number.annotate({ "description": "In minor units of the link's currency." }).check(Schema.isInt().annotate({ "expected": "an integer" })).check(Schema.isLessThanOrEqualTo(9007199254740991).annotate({ "expected": "a value less than or equal to 9007199254740991" })).check(Schema.isGreaterThan(0).annotate({ "expected": "a value greater than 0" })), "suggested_amount": Schema.optionalKey(Schema.Never), "minimum_amount": Schema.optionalKey(Schema.Never), "maximum_amount": Schema.optionalKey(Schema.Never) }).annotate({ "identifier": "FixedPricingRequestEncoded" })
export type CustomerChoosesPricingRequestEncoded = { readonly "mode": "customer_chooses", readonly "amount"?: never, readonly "suggested_amount"?: number | null, readonly "minimum_amount"?: number | null, readonly "maximum_amount"?: number | null }
export const CustomerChoosesPricingRequestEncoded = Schema.Struct({ "mode": Schema.Literal("customer_chooses"), "amount": Schema.optionalKey(Schema.Never), "suggested_amount": Schema.optionalKey(Schema.Union([Schema.Number.annotate({ "description": "In minor units of the link's currency." }).check(Schema.isInt().annotate({ "expected": "an integer" })).check(Schema.isLessThanOrEqualTo(9007199254740991).annotate({ "expected": "a value less than or equal to 9007199254740991" })).check(Schema.isGreaterThan(0).annotate({ "expected": "a value greater than 0" })), Schema.Null])), "minimum_amount": Schema.optionalKey(Schema.Union([Schema.Number.annotate({ "description": "In minor units of the link's currency." }).check(Schema.isInt().annotate({ "expected": "an integer" })).check(Schema.isLessThanOrEqualTo(9007199254740991).annotate({ "expected": "a value less than or equal to 9007199254740991" })).check(Schema.isGreaterThan(0).annotate({ "expected": "a value greater than 0" })), Schema.Null])), "maximum_amount": Schema.optionalKey(Schema.Union([Schema.Number.annotate({ "description": "In minor units of the link's currency." }).check(Schema.isInt().annotate({ "expected": "an integer" })).check(Schema.isLessThanOrEqualTo(9007199254740991).annotate({ "expected": "a value less than or equal to 9007199254740991" })).check(Schema.isGreaterThan(0).annotate({ "expected": "a value greater than 0" })), Schema.Null])) }).annotate({ "identifier": "CustomerChoosesPricingRequestEncoded" })
export type PaymentSummaryEncoded = { readonly "id": string, readonly "link_id": string, readonly "business_id": string, readonly "amount": string, readonly "currency_code": string, readonly "scale": number, readonly "status": "pending" | "succeeded" | "failed" | "cancelled" | "expired", readonly "state": "pending" | "expired" | "failed" | "cancelled" | "settling" | "settled" | "attention", readonly "created_at": string, readonly "expires_at": string, readonly "completed_at": string | null, readonly "settled_at": string | null, readonly "journal_ref": string | null, readonly "source": { readonly "kind": "link", readonly "id": string, readonly "title": string } }
export const PaymentSummaryEncoded = Schema.Struct({ "id": Schema.String, "link_id": Schema.String, "business_id": Schema.String, "amount": Schema.String.annotate({ "description": "In minor units of the link's currency." }), "currency_code": Schema.String, "scale": Schema.Number.check(Schema.isInt().annotate({ "expected": "an integer" })), "status": Schema.Literals(["pending", "succeeded", "failed", "cancelled", "expired"]), "state": Schema.Literals(["pending", "expired", "failed", "cancelled", "settling", "settled", "attention"]), "created_at": Schema.String, "expires_at": Schema.String, "completed_at": Schema.Union([Schema.String, Schema.Null]), "settled_at": Schema.Union([Schema.String, Schema.Null]), "journal_ref": Schema.Union([Schema.String, Schema.Null]), "source": Schema.Union([Schema.Struct({ "kind": Schema.Literal("link"), "id": Schema.String, "title": Schema.String })]) }).annotate({ "identifier": "PaymentSummaryEncoded" })
export type NotFoundResponseEncoded = { readonly "message": string, readonly "error": { readonly "code": "not_found" } }
export const NotFoundResponseEncoded = Schema.Struct({ "message": Schema.String.check(Schema.isMinLength(1).annotate({ "expected": "a value with a length of at least 1" })), "error": Schema.Struct({ "code": Schema.Literal("not_found") }) }).annotate({ "identifier": "NotFoundResponseEncoded" })
export type PaidEventEncoded = { readonly "kind": "paid", readonly "at": string }
export const PaidEventEncoded = Schema.Struct({ "kind": Schema.Literal("paid"), "at": Schema.String }).annotate({ "identifier": "PaidEventEncoded" })
export type SettledEventEncoded = { readonly "kind": "settled", readonly "at": string, readonly "journal_ref": string }
export const SettledEventEncoded = Schema.Struct({ "kind": Schema.Literal("settled"), "at": Schema.String, "journal_ref": Schema.String }).annotate({ "identifier": "SettledEventEncoded" })
export type RefusedEventEncoded = { readonly "kind": "refused", readonly "at": string, readonly "error_code": string }
export const RefusedEventEncoded = Schema.Struct({ "kind": Schema.Literal("refused"), "at": Schema.String, "error_code": Schema.String }).annotate({ "identifier": "RefusedEventEncoded" })
export type StartPaymentRequestEncoded = { readonly "amount"?: number | null }
export const StartPaymentRequestEncoded = Schema.Struct({ "amount": Schema.optionalKey(Schema.Union([Schema.Number.annotate({ "description": "In minor units of the link's currency." }).check(Schema.isInt().annotate({ "expected": "an integer" })).check(Schema.isLessThanOrEqualTo(9007199254740991).annotate({ "expected": "a value less than or equal to 9007199254740991" })).check(Schema.isGreaterThan(0).annotate({ "expected": "a value greater than 0" })), Schema.Null])) }).annotate({ "identifier": "StartPaymentRequestEncoded" })
export type PaymentEncoded = { readonly "id": string, readonly "amount": number, readonly "currency_code": string, readonly "scale": number, readonly "status": "pending" | "succeeded" | "failed" | "cancelled" | "expired", readonly "created_at": string, readonly "expires_at": string, readonly "completed_at": string | null }
export const PaymentEncoded = Schema.Struct({ "id": Schema.String, "amount": Schema.Number.annotate({ "description": "In minor units of the link's currency." }).check(Schema.isInt().annotate({ "expected": "an integer" })), "currency_code": Schema.String, "scale": Schema.Number.check(Schema.isInt().annotate({ "expected": "an integer" })), "status": Schema.Literals(["pending", "succeeded", "failed", "cancelled", "expired"]), "created_at": Schema.String, "expires_at": Schema.String, "completed_at": Schema.Union([Schema.String, Schema.Null]) }).annotate({ "identifier": "PaymentEncoded" })
export type StartedPaymentEncoded = { readonly "id": string, readonly "amount": number, readonly "currency_code": string, readonly "scale": number, readonly "status": "pending" | "succeeded" | "failed" | "cancelled" | "expired", readonly "created_at": string, readonly "expires_at": string, readonly "completed_at": string | null }
export const StartedPaymentEncoded = Schema.Struct({ "id": Schema.String, "amount": Schema.Number.annotate({ "description": "In minor units of the link's currency." }).check(Schema.isInt().annotate({ "expected": "an integer" })), "currency_code": Schema.String, "scale": Schema.Number.check(Schema.isInt().annotate({ "expected": "an integer" })), "status": Schema.Literals(["pending", "succeeded", "failed", "cancelled", "expired"]), "created_at": Schema.String, "expires_at": Schema.String, "completed_at": Schema.Union([Schema.String, Schema.Null]) }).annotate({ "identifier": "StartedPaymentEncoded" })
export type SimulatePaymentRequestEncoded = { readonly "outcome": "succeeded" | "failed" | "cancelled" }
export const SimulatePaymentRequestEncoded = Schema.Struct({ "outcome": Schema.Literals(["succeeded", "failed", "cancelled"]) }).annotate({ "identifier": "SimulatePaymentRequestEncoded" })
export type ValidationErrorEncoded = { readonly "code": "validation_error", readonly "details": readonly [ValidationErrorDetailEncoded, ...Array<ValidationErrorDetailEncoded>] }
export const ValidationErrorEncoded = Schema.Struct({ "code": Schema.Literal("validation_error"), "details": Schema.TupleWithRest(Schema.Tuple([ValidationErrorDetailEncoded]), [ValidationErrorDetailEncoded]) }).annotate({ "identifier": "ValidationErrorEncoded" })
export type BusinessInfoEncoded = { readonly "id": string, readonly "name": string, readonly "country_code": "NG" | "US", readonly "currency_code": string, readonly "holder_ref": string | null, readonly "status": "created" | "active", readonly "ledger": BusinessLedgerEncoded | null, readonly "created_at": string, readonly "updated_at": string }
export const BusinessInfoEncoded = Schema.Struct({ "id": Schema.String, "name": Schema.String, "country_code": Schema.Literals(["NG", "US"]), "currency_code": Schema.String, "holder_ref": Schema.Union([Schema.String, Schema.Null]), "status": Schema.Literals(["created", "active"]), "ledger": Schema.Union([BusinessLedgerEncoded, Schema.Null]), "created_at": Schema.String, "updated_at": Schema.String }).annotate({ "identifier": "BusinessInfoEncoded" })
export type PaymentLinkEncoded = { readonly "id": string, readonly "business_id": string, readonly "title": string, readonly "description": string | null, readonly "currency_code": string, readonly "scale": number, readonly "pricing": FixedPricingEncoded | CustomerChoosesPricingEncoded, readonly "share_token": string, readonly "created_at": string }
export const PaymentLinkEncoded = Schema.Struct({ "id": Schema.String, "business_id": Schema.String, "title": Schema.String, "description": Schema.Union([Schema.String, Schema.Null]), "currency_code": Schema.String, "scale": Schema.Number.check(Schema.isInt().annotate({ "expected": "an integer" })), "pricing": Schema.Union([FixedPricingEncoded, CustomerChoosesPricingEncoded]), "share_token": Schema.String, "created_at": Schema.String }).annotate({ "identifier": "PaymentLinkEncoded" })
export type CreatedPaymentLinkEncoded = { readonly "id": string, readonly "business_id": string, readonly "title": string, readonly "description": string | null, readonly "currency_code": string, readonly "scale": number, readonly "pricing": FixedPricingEncoded | CustomerChoosesPricingEncoded, readonly "share_token": string, readonly "created_at": string }
export const CreatedPaymentLinkEncoded = Schema.Struct({ "id": Schema.String, "business_id": Schema.String, "title": Schema.String, "description": Schema.Union([Schema.String, Schema.Null]), "currency_code": Schema.String, "scale": Schema.Number.check(Schema.isInt().annotate({ "expected": "an integer" })), "pricing": Schema.Union([FixedPricingEncoded, CustomerChoosesPricingEncoded]), "share_token": Schema.String, "created_at": Schema.String }).annotate({ "identifier": "CreatedPaymentLinkEncoded" })
export type PayableLinkEncoded = { readonly "business_name": string, readonly "title": string, readonly "description": string | null, readonly "currency_code": string, readonly "scale": number, readonly "pricing": FixedPricingEncoded | CustomerChoosesPricingEncoded, readonly "active": boolean }
export const PayableLinkEncoded = Schema.Struct({ "business_name": Schema.String, "title": Schema.String, "description": Schema.Union([Schema.String, Schema.Null]), "currency_code": Schema.String, "scale": Schema.Number.check(Schema.isInt().annotate({ "expected": "an integer" })), "pricing": Schema.Union([FixedPricingEncoded, CustomerChoosesPricingEncoded]), "active": Schema.Boolean }).annotate({ "identifier": "PayableLinkEncoded" })
export type PaymentLinkSummaryEncoded = { readonly "id": string, readonly "business_id": string, readonly "title": string, readonly "description": string | null, readonly "currency_code": string, readonly "scale": number, readonly "pricing": FixedPricingEncoded | CustomerChoosesPricingEncoded, readonly "share_token": string, readonly "created_at": string, readonly "active": boolean, readonly "stats": PaymentStatsEncoded }
export const PaymentLinkSummaryEncoded = Schema.Struct({ "id": Schema.String, "business_id": Schema.String, "title": Schema.String, "description": Schema.Union([Schema.String, Schema.Null]), "currency_code": Schema.String, "scale": Schema.Number.check(Schema.isInt().annotate({ "expected": "an integer" })), "pricing": Schema.Union([FixedPricingEncoded, CustomerChoosesPricingEncoded]), "share_token": Schema.String, "created_at": Schema.String, "active": Schema.Boolean, "stats": PaymentStatsEncoded }).annotate({ "identifier": "PaymentLinkSummaryEncoded" })
export type CreatePaymentLinkRequestEncoded = { readonly "title": string, readonly "description"?: string | null, readonly "pricing": FixedPricingRequestEncoded | CustomerChoosesPricingRequestEncoded }
export const CreatePaymentLinkRequestEncoded = Schema.Struct({ "title": Schema.String.check(Schema.isPattern(new RegExp(".*\\S.*")).annotate({ "expected": "a string matching the RegExp .*\\S.*" })), "description": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])), "pricing": Schema.Union([FixedPricingRequestEncoded, CustomerChoosesPricingRequestEncoded]) }).annotate({ "identifier": "CreatePaymentLinkRequestEncoded" })
export type PaymentPageEncoded = { readonly "payments": ReadonlyArray<PaymentSummaryEncoded>, readonly "stats": PaymentStatsEncoded, readonly "next": string | null }
export const PaymentPageEncoded = Schema.Struct({ "payments": Schema.Array(PaymentSummaryEncoded), "stats": PaymentStatsEncoded, "next": Schema.Union([Schema.String, Schema.Null]) }).annotate({ "identifier": "PaymentPageEncoded" })
export type PaymentDetailEncoded = { readonly "payment": PaymentSummaryEncoded, readonly "timeline": ReadonlyArray<PaidEventEncoded | SettledEventEncoded | RefusedEventEncoded> }
export const PaymentDetailEncoded = Schema.Struct({ "payment": PaymentSummaryEncoded, "timeline": Schema.Array(Schema.Union([PaidEventEncoded, SettledEventEncoded, RefusedEventEncoded])) }).annotate({ "identifier": "PaymentDetailEncoded" })
export type ValidationErrorResponseEncoded = { readonly "message": string, readonly "error": ValidationErrorEncoded }
export const ValidationErrorResponseEncoded = Schema.Struct({ "message": Schema.String.check(Schema.isMinLength(1).annotate({ "expected": "a value with a length of at least 1" })), "error": ValidationErrorEncoded }).annotate({ "identifier": "ValidationErrorResponseEncoded" })
export type MeResponseEncoded = { readonly "id": string, readonly "created_at": string, readonly "business": BusinessInfoEncoded | null }
export const MeResponseEncoded = Schema.Struct({ "id": Schema.String, "created_at": Schema.String, "business": Schema.Union([BusinessInfoEncoded, Schema.Null]) }).annotate({ "identifier": "MeResponseEncoded" })
export type PaymentLinkListEncoded = { readonly "links": ReadonlyArray<PaymentLinkSummaryEncoded>, readonly "link_count": number, readonly "active_link_count": number, readonly "totals": PaymentStatsEncoded }
export const PaymentLinkListEncoded = Schema.Struct({ "links": Schema.Array(PaymentLinkSummaryEncoded), "link_count": Schema.Number.check(Schema.isInt().annotate({ "expected": "an integer" })), "active_link_count": Schema.Number.check(Schema.isInt().annotate({ "expected": "an integer" })), "totals": PaymentStatsEncoded }).annotate({ "identifier": "PaymentLinkListEncoded" })
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
export type BusinessCreateAccount200 = BusinessInfoEncoded
export const BusinessCreateAccount200 = BusinessInfoEncoded
export type BusinessCreateAccount400 = ValidationErrorResponseEncoded
export const BusinessCreateAccount400 = ValidationErrorResponseEncoded
export type BusinessCreateAccount401 = UnauthorizedResponseEncoded
export const BusinessCreateAccount401 = UnauthorizedResponseEncoded
export type BusinessCreateAccount409 = ConflictResponseEncoded
export const BusinessCreateAccount409 = ConflictResponseEncoded
export type BusinessCreateAccount502 = BadGatewayResponseEncoded
export const BusinessCreateAccount502 = BadGatewayResponseEncoded
export type BusinessCreateAccount503 = ServiceUnavailableResponseEncoded
export const BusinessCreateAccount503 = ServiceUnavailableResponseEncoded
export type PaymentLinksListPaymentLinks200 = PaymentLinkListEncoded
export const PaymentLinksListPaymentLinks200 = PaymentLinkListEncoded
export type PaymentLinksListPaymentLinks400 = ValidationErrorResponseEncoded
export const PaymentLinksListPaymentLinks400 = ValidationErrorResponseEncoded
export type PaymentLinksListPaymentLinks401 = UnauthorizedResponseEncoded
export const PaymentLinksListPaymentLinks401 = UnauthorizedResponseEncoded
export type PaymentLinksListPaymentLinks409 = ConflictResponseEncoded
export const PaymentLinksListPaymentLinks409 = ConflictResponseEncoded
export type PaymentLinksCreatePaymentLinkParams = { readonly "idempotency-key": string }
export const PaymentLinksCreatePaymentLinkParams = Schema.Struct({ "idempotency-key": Schema.String.check(Schema.isPattern(new RegExp("^[!-~]{1,255}$")).annotate({ "expected": "a string matching the RegExp ^[!-~]{1,255}$" })) })
export type PaymentLinksCreatePaymentLinkRequestJson = CreatePaymentLinkRequestEncoded
export const PaymentLinksCreatePaymentLinkRequestJson = CreatePaymentLinkRequestEncoded
export type PaymentLinksCreatePaymentLink200 = PaymentLinkEncoded
export const PaymentLinksCreatePaymentLink200 = PaymentLinkEncoded
export type PaymentLinksCreatePaymentLink201 = CreatedPaymentLinkEncoded
export const PaymentLinksCreatePaymentLink201 = CreatedPaymentLinkEncoded
export type PaymentLinksCreatePaymentLink400 = ValidationErrorResponseEncoded
export const PaymentLinksCreatePaymentLink400 = ValidationErrorResponseEncoded
export type PaymentLinksCreatePaymentLink401 = UnauthorizedResponseEncoded
export const PaymentLinksCreatePaymentLink401 = UnauthorizedResponseEncoded
export type PaymentLinksCreatePaymentLink409 = ConflictResponseEncoded
export const PaymentLinksCreatePaymentLink409 = ConflictResponseEncoded
export type PaymentsListPaymentsParams = { readonly "link_id"?: string, readonly "state"?: "pending" | "expired" | "failed" | "cancelled" | "settling" | "settled" | "attention", readonly "before"?: string }
export const PaymentsListPaymentsParams = Schema.Struct({ "link_id": Schema.optionalKey(Schema.String), "state": Schema.optionalKey(Schema.Literals(["pending", "expired", "failed", "cancelled", "settling", "settled", "attention"])), "before": Schema.optionalKey(Schema.String) })
export type PaymentsListPayments200 = PaymentPageEncoded
export const PaymentsListPayments200 = PaymentPageEncoded
export type PaymentsListPayments400 = ValidationErrorResponseEncoded
export const PaymentsListPayments400 = ValidationErrorResponseEncoded
export type PaymentsListPayments401 = UnauthorizedResponseEncoded
export const PaymentsListPayments401 = UnauthorizedResponseEncoded
export type PaymentsListPayments404 = NotFoundResponseEncoded
export const PaymentsListPayments404 = NotFoundResponseEncoded
export type PaymentsListPayments409 = ConflictResponseEncoded
export const PaymentsListPayments409 = ConflictResponseEncoded
export type PaymentsGetPayment200 = PaymentDetailEncoded
export const PaymentsGetPayment200 = PaymentDetailEncoded
export type PaymentsGetPayment400 = ValidationErrorResponseEncoded
export const PaymentsGetPayment400 = ValidationErrorResponseEncoded
export type PaymentsGetPayment401 = UnauthorizedResponseEncoded
export const PaymentsGetPayment401 = UnauthorizedResponseEncoded
export type PaymentsGetPayment404 = NotFoundResponseEncoded
export const PaymentsGetPayment404 = NotFoundResponseEncoded
export type PaymentsGetPayment409 = ConflictResponseEncoded
export const PaymentsGetPayment409 = ConflictResponseEncoded
export type PayPaymentLink200 = PayableLinkEncoded
export const PayPaymentLink200 = PayableLinkEncoded
export type PayPaymentLink400 = ValidationErrorResponseEncoded
export const PayPaymentLink400 = ValidationErrorResponseEncoded
export type PayPaymentLink404 = NotFoundResponseEncoded
export const PayPaymentLink404 = NotFoundResponseEncoded
export type PayStartPaymentParams = { readonly "idempotency-key": string }
export const PayStartPaymentParams = Schema.Struct({ "idempotency-key": Schema.String.check(Schema.isPattern(new RegExp("^[!-~]{1,255}$")).annotate({ "expected": "a string matching the RegExp ^[!-~]{1,255}$" })) })
export type PayStartPaymentRequestJson = StartPaymentRequestEncoded
export const PayStartPaymentRequestJson = StartPaymentRequestEncoded
export type PayStartPayment200 = PaymentEncoded
export const PayStartPayment200 = PaymentEncoded
export type PayStartPayment201 = StartedPaymentEncoded
export const PayStartPayment201 = StartedPaymentEncoded
export type PayStartPayment400 = ValidationErrorResponseEncoded
export const PayStartPayment400 = ValidationErrorResponseEncoded
export type PayStartPayment404 = NotFoundResponseEncoded
export const PayStartPayment404 = NotFoundResponseEncoded
export type PayStartPayment409 = ConflictResponseEncoded
export const PayStartPayment409 = ConflictResponseEncoded
export type PaySimulatePaymentRequestJson = SimulatePaymentRequestEncoded
export const PaySimulatePaymentRequestJson = SimulatePaymentRequestEncoded
export type PaySimulatePayment200 = PaymentEncoded
export const PaySimulatePayment200 = PaymentEncoded
export type PaySimulatePayment400 = ValidationErrorResponseEncoded
export const PaySimulatePayment400 = ValidationErrorResponseEncoded
export type PaySimulatePayment404 = NotFoundResponseEncoded
export const PaySimulatePayment404 = NotFoundResponseEncoded
export type PaySimulatePayment409 = ConflictResponseEncoded
export const PaySimulatePayment409 = ConflictResponseEncoded

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
    "businessCreateAccount": (options) => HttpClientRequest.post("/business/account").pipe(
      withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(BusinessCreateAccount200),
      "400": decodeError("BusinessCreateAccount400", BusinessCreateAccount400),
      "401": decodeError("BusinessCreateAccount401", BusinessCreateAccount401),
      "409": decodeError("BusinessCreateAccount409", BusinessCreateAccount409),
      "502": decodeError("BusinessCreateAccount502", BusinessCreateAccount502),
      "503": decodeError("BusinessCreateAccount503", BusinessCreateAccount503),
      orElse: unexpectedStatus
    }))
    ),
    "paymentLinksListPaymentLinks": (options) => HttpClientRequest.get("/payment_links").pipe(
      withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(PaymentLinksListPaymentLinks200),
      "400": decodeError("PaymentLinksListPaymentLinks400", PaymentLinksListPaymentLinks400),
      "401": decodeError("PaymentLinksListPaymentLinks401", PaymentLinksListPaymentLinks401),
      "409": decodeError("PaymentLinksListPaymentLinks409", PaymentLinksListPaymentLinks409),
      orElse: unexpectedStatus
    }))
    ),
    "paymentLinksCreatePaymentLink": (options) => HttpClientRequest.post("/payment_links").pipe(
      HttpClientRequest.setHeaders({ "idempotency-key": options.params["idempotency-key"] ?? undefined }),
      HttpClientRequest.bodyJsonUnsafe(options.payload),
      withResponse(options.config)(HttpClientResponse.matchStatus({
      "200": decodeSuccess(PaymentLinksCreatePaymentLink200),
      "201": decodeSuccess(PaymentLinksCreatePaymentLink201),
      "400": decodeError("PaymentLinksCreatePaymentLink400", PaymentLinksCreatePaymentLink400),
      "401": decodeError("PaymentLinksCreatePaymentLink401", PaymentLinksCreatePaymentLink401),
      "409": decodeError("PaymentLinksCreatePaymentLink409", PaymentLinksCreatePaymentLink409),
      orElse: unexpectedStatus
    }))
    ),
    "paymentsListPayments": (options) => HttpClientRequest.get("/payments").pipe(
      HttpClientRequest.setUrlParams({ "link_id": options?.params?.["link_id"] as any, "state": options?.params?.["state"] as any, "before": options?.params?.["before"] as any }),
      withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(PaymentsListPayments200),
      "400": decodeError("PaymentsListPayments400", PaymentsListPayments400),
      "401": decodeError("PaymentsListPayments401", PaymentsListPayments401),
      "404": decodeError("PaymentsListPayments404", PaymentsListPayments404),
      "409": decodeError("PaymentsListPayments409", PaymentsListPayments409),
      orElse: unexpectedStatus
    }))
    ),
    "paymentsGetPayment": (paymentId, options) => __makePathRequest(HttpClientRequest.get, [paymentId], () => "/payments/" + __encodePathParam(paymentId) + "").pipe(
    Effect.flatMap((request) => request.pipe(
      withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(PaymentsGetPayment200),
      "400": decodeError("PaymentsGetPayment400", PaymentsGetPayment400),
      "401": decodeError("PaymentsGetPayment401", PaymentsGetPayment401),
      "404": decodeError("PaymentsGetPayment404", PaymentsGetPayment404),
      "409": decodeError("PaymentsGetPayment409", PaymentsGetPayment409),
      orElse: unexpectedStatus
    }))
    ))
  ),
    "payPaymentLink": (shareToken, options) => __makePathRequest(HttpClientRequest.get, [shareToken], () => "/pay/payment_links/" + __encodePathParam(shareToken) + "").pipe(
    Effect.flatMap((request) => request.pipe(
      withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(PayPaymentLink200),
      "400": decodeError("PayPaymentLink400", PayPaymentLink400),
      "404": decodeError("PayPaymentLink404", PayPaymentLink404),
      orElse: unexpectedStatus
    }))
    ))
  ),
    "payStartPayment": (shareToken, options) => __makePathRequest(HttpClientRequest.post, [shareToken], () => "/pay/payment_links/" + __encodePathParam(shareToken) + "/payments").pipe(
    Effect.flatMap((request) => request.pipe(
      HttpClientRequest.setHeaders({ "idempotency-key": options.params["idempotency-key"] ?? undefined }),
      HttpClientRequest.bodyJsonUnsafe(options.payload),
      withResponse(options.config)(HttpClientResponse.matchStatus({
      "200": decodeSuccess(PayStartPayment200),
      "201": decodeSuccess(PayStartPayment201),
      "400": decodeError("PayStartPayment400", PayStartPayment400),
      "404": decodeError("PayStartPayment404", PayStartPayment404),
      "409": decodeError("PayStartPayment409", PayStartPayment409),
      orElse: unexpectedStatus
    }))
    ))
  ),
    "paySimulatePayment": (shareToken, paymentId, options) => __makePathRequest(HttpClientRequest.post, [shareToken, paymentId], () => "/pay/payment_links/" + __encodePathParam(shareToken) + "/payments/" + __encodePathParam(paymentId) + "/simulate").pipe(
    Effect.flatMap((request) => request.pipe(
      HttpClientRequest.bodyJsonUnsafe(options.payload),
      withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(PaySimulatePayment200),
      "400": decodeError("PaySimulatePayment400", PaySimulatePayment400),
      "404": decodeError("PaySimulatePayment404", PaySimulatePayment404),
      "409": decodeError("PaySimulatePayment409", PaySimulatePayment409),
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
  readonly "businessCreateAccount": <Config extends OperationConfig>(options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof BusinessCreateAccount200.Type, Config>, HttpClientError.HttpClientError | SchemaError | PlaneClientError<"BusinessCreateAccount400", typeof BusinessCreateAccount400.Type> | PlaneClientError<"BusinessCreateAccount401", typeof BusinessCreateAccount401.Type> | PlaneClientError<"BusinessCreateAccount409", typeof BusinessCreateAccount409.Type> | PlaneClientError<"BusinessCreateAccount502", typeof BusinessCreateAccount502.Type> | PlaneClientError<"BusinessCreateAccount503", typeof BusinessCreateAccount503.Type>>
  readonly "paymentLinksListPaymentLinks": <Config extends OperationConfig>(options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof PaymentLinksListPaymentLinks200.Type, Config>, HttpClientError.HttpClientError | SchemaError | PlaneClientError<"PaymentLinksListPaymentLinks400", typeof PaymentLinksListPaymentLinks400.Type> | PlaneClientError<"PaymentLinksListPaymentLinks401", typeof PaymentLinksListPaymentLinks401.Type> | PlaneClientError<"PaymentLinksListPaymentLinks409", typeof PaymentLinksListPaymentLinks409.Type>>
  readonly "paymentLinksCreatePaymentLink": <Config extends OperationConfig>(options: { readonly params: typeof PaymentLinksCreatePaymentLinkParams.Encoded; readonly payload: typeof PaymentLinksCreatePaymentLinkRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof PaymentLinksCreatePaymentLink200.Type | typeof PaymentLinksCreatePaymentLink201.Type, Config>, HttpClientError.HttpClientError | SchemaError | PlaneClientError<"PaymentLinksCreatePaymentLink400", typeof PaymentLinksCreatePaymentLink400.Type> | PlaneClientError<"PaymentLinksCreatePaymentLink401", typeof PaymentLinksCreatePaymentLink401.Type> | PlaneClientError<"PaymentLinksCreatePaymentLink409", typeof PaymentLinksCreatePaymentLink409.Type>>
  readonly "paymentsListPayments": <Config extends OperationConfig>(options: { readonly params?: typeof PaymentsListPaymentsParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof PaymentsListPayments200.Type, Config>, HttpClientError.HttpClientError | SchemaError | PlaneClientError<"PaymentsListPayments400", typeof PaymentsListPayments400.Type> | PlaneClientError<"PaymentsListPayments401", typeof PaymentsListPayments401.Type> | PlaneClientError<"PaymentsListPayments404", typeof PaymentsListPayments404.Type> | PlaneClientError<"PaymentsListPayments409", typeof PaymentsListPayments409.Type>>
  readonly "paymentsGetPayment": <Config extends OperationConfig>(paymentId: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof PaymentsGetPayment200.Type, Config>, HttpClientError.HttpClientError | SchemaError | PlaneClientError<"PaymentsGetPayment400", typeof PaymentsGetPayment400.Type> | PlaneClientError<"PaymentsGetPayment401", typeof PaymentsGetPayment401.Type> | PlaneClientError<"PaymentsGetPayment404", typeof PaymentsGetPayment404.Type> | PlaneClientError<"PaymentsGetPayment409", typeof PaymentsGetPayment409.Type>>
  readonly "payPaymentLink": <Config extends OperationConfig>(shareToken: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof PayPaymentLink200.Type, Config>, HttpClientError.HttpClientError | SchemaError | PlaneClientError<"PayPaymentLink400", typeof PayPaymentLink400.Type> | PlaneClientError<"PayPaymentLink404", typeof PayPaymentLink404.Type>>
  readonly "payStartPayment": <Config extends OperationConfig>(shareToken: string, options: { readonly params: typeof PayStartPaymentParams.Encoded; readonly payload: typeof PayStartPaymentRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof PayStartPayment200.Type | typeof PayStartPayment201.Type, Config>, HttpClientError.HttpClientError | SchemaError | PlaneClientError<"PayStartPayment400", typeof PayStartPayment400.Type> | PlaneClientError<"PayStartPayment404", typeof PayStartPayment404.Type> | PlaneClientError<"PayStartPayment409", typeof PayStartPayment409.Type>>
  readonly "paySimulatePayment": <Config extends OperationConfig>(shareToken: string, paymentId: string, options: { readonly payload: typeof PaySimulatePaymentRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof PaySimulatePayment200.Type, Config>, HttpClientError.HttpClientError | SchemaError | PlaneClientError<"PaySimulatePayment400", typeof PaySimulatePayment400.Type> | PlaneClientError<"PaySimulatePayment404", typeof PaySimulatePayment404.Type> | PlaneClientError<"PaySimulatePayment409", typeof PaySimulatePayment409.Type>>
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
