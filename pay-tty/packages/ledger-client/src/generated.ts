import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import type { SchemaError } from "effect/Schema"
import * as Schema from "effect/Schema"
import type * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientError from "effect/unstable/http/HttpClientError"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
// non-recursive definitions
export type HealthResponse = { readonly "status": string }
export const HealthResponse = Schema.Struct({ "status": Schema.String.annotate({ "examples": ["ok"] }) }).annotate({ "identifier": "HealthResponse" })
export type LedgerSlug = string
export const LedgerSlug = Schema.String.annotate({ "description": "Opaque identifier assigned to the ledger.", "examples": ["ngn_ng"] }).check(Schema.isMinLength(3).annotate({ "expected": "a value with a length of at least 3" })).check(Schema.isMaxLength(63).annotate({ "expected": "a value with a length of at most 63" })).check(Schema.isPattern(new RegExp("^[a-z0-9]+(?:_[a-z0-9]+)*$")).annotate({ "expected": "a string matching the RegExp ^[a-z0-9]+(?:_[a-z0-9]+)*$", "identifier": "LedgerSlug" }))
export type HolderReference = string
export const HolderReference = Schema.String.annotate({ "description": "Stable opaque reference assigned to a holder by the ledger.", "examples": ["hld_01K33YVADP5Z8B0T3X2Q91C6RH"] }).check(Schema.isMinLength(1).annotate({ "expected": "a value with a length of at least 1" })).check(Schema.isMaxLength(64).annotate({ "expected": "a value with a length of at most 64", "identifier": "HolderReference" }))
export type AccountReference = string
export const AccountReference = Schema.String.annotate({ "description": "Stable opaque reference assigned to an account by the ledger.", "examples": ["acct_01K33YV8M82N9MXP4E7J6B1QWK"] }).check(Schema.isMinLength(1).annotate({ "expected": "a value with a length of at least 1" })).check(Schema.isMaxLength(64).annotate({ "expected": "a value with a length of at most 64", "identifier": "AccountReference" }))
export type PayableAccountKind = "payable"
export const PayableAccountKind = Schema.Literal("payable").annotate({ "examples": ["payable"], "identifier": "PayableAccountKind" })
export type AccountStatus = "open" | "closed"
export const AccountStatus = Schema.Literals(["open", "closed"]).annotate({ "description": "Whether the payable account itself is open or closed.", "examples": ["open"], "identifier": "AccountStatus" })
export type AvailableBalance = number
export const AvailableBalance = Schema.Number.annotate({ "description": "Derived available amount in minor units (credits_posted - debits_posted - debits_pending).", "examples": [9800], "format": "int64" }).check(Schema.isInt().annotate({ "expected": "an integer" })).check(Schema.isGreaterThanOrEqualTo(0).annotate({ "expected": "a value greater than or equal to 0", "identifier": "AvailableBalance" }))
export type AccountBalances = { readonly "debits_pending": number, readonly "credits_pending": number, readonly "debits_posted": number, readonly "credits_posted": number }
export const AccountBalances = Schema.Struct({ "debits_pending": Schema.Number.annotate({ "description": "Total pending debit amount in minor units.", "examples": [200], "format": "int64" }).check(Schema.isInt().annotate({ "expected": "an integer" })).check(Schema.isGreaterThanOrEqualTo(0).annotate({ "expected": "a value greater than or equal to 0" })), "credits_pending": Schema.Number.annotate({ "description": "Total pending credit amount in minor units.", "examples": [0], "format": "int64" }).check(Schema.isInt().annotate({ "expected": "an integer" })).check(Schema.isGreaterThanOrEqualTo(0).annotate({ "expected": "a value greater than or equal to 0" })), "debits_posted": Schema.Number.annotate({ "description": "Total posted debit amount in minor units.", "examples": [0], "format": "int64" }).check(Schema.isInt().annotate({ "expected": "an integer" })).check(Schema.isGreaterThanOrEqualTo(0).annotate({ "expected": "a value greater than or equal to 0" })), "credits_posted": Schema.Number.annotate({ "description": "Total posted credit amount in minor units.", "examples": [10000], "format": "int64" }).check(Schema.isInt().annotate({ "expected": "an integer" })).check(Schema.isGreaterThanOrEqualTo(0).annotate({ "expected": "a value greater than or equal to 0" })) }).annotate({ "identifier": "AccountBalances" })
export type ValidationErrorDetail = { readonly "location": "request" | "path" | "query" | "header" | "body", readonly "field": string, readonly "code": "required" | "invalid_type" | "invalid_format" | "invalid_value" | "min_length" | "max_length" | "unknown_field", readonly "message": string }
export const ValidationErrorDetail = Schema.Struct({ "location": Schema.Literals(["request", "path", "query", "header", "body"]), "field": Schema.String.annotate({ "examples": ["external_id"] }).check(Schema.isMinLength(1).annotate({ "expected": "a value with a length of at least 1" })), "code": Schema.Literals(["required", "invalid_type", "invalid_format", "invalid_value", "min_length", "max_length", "unknown_field"]), "message": Schema.String.annotate({ "examples": ["external_id is required"] }).check(Schema.isMinLength(1).annotate({ "expected": "a value with a length of at least 1" })) }).annotate({ "identifier": "ValidationErrorDetail" })
export type ErrorCode = "ledger_not_found" | "ledger_closed" | "holder_conflict" | "account_not_found" | "account_closed" | "insufficient_funds" | "idempotency_conflict" | "internal_server_error"
export const ErrorCode = Schema.Literals(["ledger_not_found", "ledger_closed", "holder_conflict", "account_not_found", "account_closed", "insufficient_funds", "idempotency_conflict", "internal_server_error"]).annotate({ "identifier": "ErrorCode" })
export type StatementPeriod = { readonly "from": string, readonly "to": string }
export const StatementPeriod = Schema.Struct({ "from": Schema.String.annotate({ "examples": ["2026-09-01T00:00:00Z"], "format": "date-time" }), "to": Schema.String.annotate({ "examples": ["2026-10-01T00:00:00Z"], "format": "date-time" }) }).annotate({ "identifier": "StatementPeriod" })
export type JournalRef = string
export const JournalRef = Schema.String.annotate({ "description": "Stable opaque reference assigned to a journal entry by the ledger.", "examples": ["jrn_01K33YW0MDHJ9E4N7Z2QPV6R8K"] }).check(Schema.isMinLength(1).annotate({ "expected": "a value with a length of at least 1" })).check(Schema.isMaxLength(64).annotate({ "expected": "a value with a length of at most 64", "identifier": "JournalRef" }))
export type JournalEntryKind = string
export const JournalEntryKind = Schema.String.annotate({ "description": "Business classification of a journal entry." }).check(Schema.isMinLength(1).annotate({ "expected": "a value with a length of at least 1" })).check(Schema.isMaxLength(64).annotate({ "expected": "a value with a length of at most 64" })).check(Schema.isPattern(new RegExp(".*\\S.*")).annotate({ "expected": "a string matching the RegExp .*\\S.*", "identifier": "JournalEntryKind" }))
export type StatementDirection = "debit" | "credit"
export const StatementDirection = Schema.Literals(["debit", "credit"]).annotate({ "examples": ["credit"], "identifier": "StatementDirection" })
export type StatementPage = { readonly "limit": number, readonly "previous_cursor": string | null, readonly "next_cursor": string | null }
export const StatementPage = Schema.Struct({ "limit": Schema.Number.annotate({ "examples": [50] }).check(Schema.isInt().annotate({ "expected": "an integer" })).check(Schema.isGreaterThanOrEqualTo(1).annotate({ "expected": "a value greater than or equal to 1" })).check(Schema.isLessThanOrEqualTo(100).annotate({ "expected": "a value less than or equal to 100" })), "previous_cursor": Schema.Union([Schema.String, Schema.Null]).annotate({ "examples": [null] }), "next_cursor": Schema.Union([Schema.String, Schema.Null]).annotate({ "examples": ["eyJ..."] }) }).annotate({ "identifier": "StatementPage" })
export type IdempotencyKey = string
export const IdempotencyKey = Schema.String.annotate({ "description": "Caller-generated identifier used to make a ledger operation idempotent.", "examples": ["payment_123"] }).check(Schema.isMinLength(1).annotate({ "expected": "a value with a length of at least 1" })).check(Schema.isMaxLength(255).annotate({ "expected": "a value with a length of at most 255" })).check(Schema.isPattern(new RegExp(".*\\S.*")).annotate({ "expected": "a string matching the RegExp .*\\S.*", "identifier": "IdempotencyKey" }))
export type CreatePayableAccountRequest = { readonly "ledger": LedgerSlug, readonly "external_id": string, readonly "name": string } & { readonly [x: string]: Schema.Json }
export const CreatePayableAccountRequest = Schema.StructWithRest(Schema.Struct({ "ledger": LedgerSlug, "external_id": Schema.String.check(Schema.isMinLength(1).annotate({ "expected": "a value with a length of at least 1" })).check(Schema.isMaxLength(255).annotate({ "expected": "a value with a length of at most 255" })).check(Schema.isPattern(new RegExp(".*\\S.*")).annotate({ "expected": "a string matching the RegExp .*\\S.*" })), "name": Schema.String.check(Schema.isMinLength(1).annotate({ "expected": "a value with a length of at least 1" })).check(Schema.isMaxLength(255).annotate({ "expected": "a value with a length of at most 255" })).check(Schema.isPattern(new RegExp(".*\\S.*")).annotate({ "expected": "a string matching the RegExp .*\\S.*" })) }), [Schema.Record(Schema.String, Schema.Json.annotate({ "expected": "JSON value" }))]).annotate({ "identifier": "CreatePayableAccountRequest" })
export type StatementAccount = { readonly "reference": AccountReference, readonly "holder_reference": HolderReference, readonly "name": string }
export const StatementAccount = Schema.Struct({ "reference": AccountReference, "holder_reference": HolderReference, "name": Schema.String.annotate({ "examples": ["Acme Ltd"] }).check(Schema.isMinLength(1).annotate({ "expected": "a value with a length of at least 1" })) }).annotate({ "identifier": "StatementAccount" })
export type PostJournalEntryLine = { readonly "debit_account_ref": AccountReference, readonly "credit_account_ref": AccountReference, readonly "amount": number, readonly "purpose": string } & { readonly [x: string]: Schema.Json }
export const PostJournalEntryLine = Schema.StructWithRest(Schema.Struct({ "debit_account_ref": AccountReference, "credit_account_ref": AccountReference, "amount": Schema.Number.annotate({ "description": "Positive amount expressed in the ledger's minor units.", "examples": [10000], "format": "int64" }).check(Schema.isInt().annotate({ "expected": "an integer" })).check(Schema.isGreaterThanOrEqualTo(1).annotate({ "expected": "a value greater than or equal to 1" })).check(Schema.isLessThanOrEqualTo(9223372036854776000).annotate({ "expected": "a value less than or equal to 9223372036854776000" })), "purpose": Schema.String.annotate({ "description": "What this line's amount is for within the entry, such as a fee or tax. Client-defined." }).check(Schema.isMinLength(1).annotate({ "expected": "a value with a length of at least 1" })).check(Schema.isMaxLength(100).annotate({ "expected": "a value with a length of at most 100" })).check(Schema.isPattern(new RegExp(".*\\S.*")).annotate({ "expected": "a string matching the RegExp .*\\S.*" })) }), [Schema.Record(Schema.String, Schema.Json.annotate({ "expected": "JSON value" }))]).annotate({ "identifier": "PostJournalEntryLine" })
export type CreatePayableAccountResponse = { readonly "holder_reference": HolderReference, readonly "reference": AccountReference, readonly "ledger_slug": LedgerSlug, readonly "external_id": string, readonly "name": string, readonly "kind": PayableAccountKind, readonly "status": AccountStatus, readonly "closed_at": string | null, readonly "available": AvailableBalance, readonly "balances": AccountBalances, readonly "created_at": string }
export const CreatePayableAccountResponse = Schema.Struct({ "holder_reference": HolderReference, "reference": AccountReference, "ledger_slug": LedgerSlug, "external_id": Schema.String.annotate({ "examples": ["merchant_123"] }).check(Schema.isMinLength(1).annotate({ "expected": "a value with a length of at least 1" })), "name": Schema.String.annotate({ "examples": ["Acme Ltd"] }).check(Schema.isMinLength(1).annotate({ "expected": "a value with a length of at least 1" })), "kind": PayableAccountKind, "status": AccountStatus, "closed_at": Schema.Union([Schema.String, Schema.Null]).annotate({ "examples": [null], "format": "date-time" }), "available": AvailableBalance, "balances": AccountBalances, "created_at": Schema.String.annotate({ "format": "date-time" }) }).annotate({ "identifier": "CreatePayableAccountResponse" })
export type GetAccountResponse = { readonly "reference": AccountReference, readonly "holder_reference": HolderReference, readonly "ledger_slug": LedgerSlug, readonly "kind": PayableAccountKind, readonly "name": string, readonly "status": AccountStatus, readonly "closed_at": string | null, readonly "available": AvailableBalance, readonly "balances": AccountBalances, readonly "created_at": string }
export const GetAccountResponse = Schema.Struct({ "reference": AccountReference, "holder_reference": HolderReference, "ledger_slug": LedgerSlug, "kind": PayableAccountKind, "name": Schema.String.annotate({ "examples": ["Acme Ltd"] }).check(Schema.isMinLength(1).annotate({ "expected": "a value with a length of at least 1" })), "status": AccountStatus, "closed_at": Schema.Union([Schema.String, Schema.Null]).annotate({ "examples": [null], "format": "date-time" }), "available": AvailableBalance, "balances": AccountBalances, "created_at": Schema.String.annotate({ "format": "date-time" }) }).annotate({ "examples": [{ "reference": "acct_01K33YV8M82N9MXP4E7J6B1QWK", "holder_reference": "hld_01K33YVADP5Z8B0T3X2Q91C6RH", "ledger_slug": "ngn_ng", "kind": "payable", "name": "Acme Ltd", "status": "open", "closed_at": null, "available": 9800, "balances": { "debits_pending": 200, "credits_pending": 0, "debits_posted": 0, "credits_posted": 10000 }, "created_at": "2026-09-08T10:30:00Z" }], "identifier": "GetAccountResponse" })
export type ValidationError = { readonly "code": "validation_error", readonly "details": ReadonlyArray<ValidationErrorDetail> }
export const ValidationError = Schema.Struct({ "code": Schema.Literal("validation_error"), "details": Schema.Array(ValidationErrorDetail).check(Schema.isMinLength(1).annotate({ "expected": "a value with a length of at least 1" })) }).annotate({ "identifier": "ValidationError" })
export type ErrorInfo = { readonly "code": ErrorCode }
export const ErrorInfo = Schema.Struct({ "code": ErrorCode }).annotate({ "identifier": "ErrorInfo" })
export type BatchEntryError = { readonly "code": ErrorCode, readonly "message": string }
export const BatchEntryError = Schema.Struct({ "code": ErrorCode, "message": Schema.String }).annotate({ "identifier": "BatchEntryError" })
export type PostJournalEntryResponse = { readonly "journal_ref": JournalRef, readonly "ledger_slug": LedgerSlug, readonly "kind": JournalEntryKind, readonly "state": "posted", readonly "description": string, readonly "effective_at": string, readonly "created_at": string }
export const PostJournalEntryResponse = Schema.Struct({ "journal_ref": JournalRef, "ledger_slug": LedgerSlug, "kind": JournalEntryKind, "state": Schema.Literal("posted"), "description": Schema.String.check(Schema.isMinLength(1).annotate({ "expected": "a value with a length of at least 1" })), "effective_at": Schema.String.annotate({ "format": "date-time" }), "created_at": Schema.String.annotate({ "format": "date-time" }) }).annotate({ "identifier": "PostJournalEntryResponse" })
export type StatementMovement = { readonly "journal_reference": JournalRef, readonly "line_number": number, readonly "kind": JournalEntryKind, readonly "direction": StatementDirection, readonly "amount": number, readonly "balance_after": number, readonly "description": string, readonly "purpose": string, readonly "recorded_at": string }
export const StatementMovement = Schema.Struct({ "journal_reference": JournalRef, "line_number": Schema.Number.annotate({ "examples": [1] }).check(Schema.isInt().annotate({ "expected": "an integer" })).check(Schema.isGreaterThanOrEqualTo(1).annotate({ "expected": "a value greater than or equal to 1" })), "kind": JournalEntryKind, "direction": StatementDirection, "amount": Schema.Number.annotate({ "description": "Positive amount expressed in the ledger's minor units.", "examples": [9800], "format": "int64" }).check(Schema.isInt().annotate({ "expected": "an integer" })).check(Schema.isGreaterThanOrEqualTo(1).annotate({ "expected": "a value greater than or equal to 1" })), "balance_after": Schema.Number.annotate({ "description": "Posted balance after this movement in minor units.", "examples": [9800], "format": "int64" }).check(Schema.isInt().annotate({ "expected": "an integer" })), "description": Schema.String.annotate({ "examples": ["Payment received"] }).check(Schema.isMinLength(1).annotate({ "expected": "a value with a length of at least 1" })), "purpose": Schema.String.annotate({ "examples": ["Card payment"] }).check(Schema.isMinLength(1).annotate({ "expected": "a value with a length of at least 1" })), "recorded_at": Schema.String.annotate({ "examples": ["2026-09-10T09:15:00Z"], "format": "date-time" }) }).annotate({ "identifier": "StatementMovement" })
export type PostJournalEntryRequest = { readonly "ledger": LedgerSlug, readonly "kind": JournalEntryKind, readonly "description": string, readonly "effective_at"?: string, readonly "lines": ReadonlyArray<PostJournalEntryLine> } & { readonly [x: string]: Schema.Json }
export const PostJournalEntryRequest = Schema.StructWithRest(Schema.Struct({ "ledger": LedgerSlug, "kind": JournalEntryKind, "description": Schema.String.check(Schema.isMinLength(1).annotate({ "expected": "a value with a length of at least 1" })).check(Schema.isMaxLength(500).annotate({ "expected": "a value with a length of at most 500" })).check(Schema.isPattern(new RegExp(".*\\S.*")).annotate({ "expected": "a string matching the RegExp .*\\S.*" })), "effective_at": Schema.optionalKey(Schema.String.annotate({ "format": "date-time" })), "lines": Schema.Array(PostJournalEntryLine).check(Schema.isMinLength(1).annotate({ "expected": "a value with a length of at least 1" })).check(Schema.isMaxLength(100).annotate({ "expected": "a value with a length of at most 100" })) }), [Schema.Record(Schema.String, Schema.Json.annotate({ "expected": "JSON value" }))]).annotate({ "identifier": "PostJournalEntryRequest" })
export type BatchPostEntryItem = { readonly "idempotency_key": IdempotencyKey, readonly "kind": JournalEntryKind, readonly "description": string, readonly "effective_at"?: string, readonly "lines": ReadonlyArray<PostJournalEntryLine> } & { readonly [x: string]: Schema.Json }
export const BatchPostEntryItem = Schema.StructWithRest(Schema.Struct({ "idempotency_key": Schema.suspend((): Schema.Codec<IdempotencyKey> => IdempotencyKey).annotate({ "description": "Identifies this entry, not the request: the entry is the unit that is retried and the unit that comes back as `existing`. It shares one keyspace per ledger with the key sent to `POST /entries`, so the same key through either endpoint names the same entry." }), "kind": JournalEntryKind, "description": Schema.String.check(Schema.isMinLength(1).annotate({ "expected": "a value with a length of at least 1" })).check(Schema.isMaxLength(500).annotate({ "expected": "a value with a length of at most 500" })).check(Schema.isPattern(new RegExp(".*\\S.*")).annotate({ "expected": "a string matching the RegExp .*\\S.*" })), "effective_at": Schema.optionalKey(Schema.String.annotate({ "format": "date-time" })), "lines": Schema.Array(PostJournalEntryLine).check(Schema.isMinLength(1).annotate({ "expected": "a value with a length of at least 1" })).check(Schema.isMaxLength(100).annotate({ "expected": "a value with a length of at most 100" })) }), [Schema.Record(Schema.String, Schema.Json.annotate({ "expected": "JSON value" }))]).annotate({ "identifier": "BatchPostEntryItem" })
export type ValidationErrorResponse = { readonly "message": string, readonly "error": ValidationError }
export const ValidationErrorResponse = Schema.Struct({ "message": Schema.String.annotate({ "examples": ["Request validation failed."] }).check(Schema.isMinLength(1).annotate({ "expected": "a value with a length of at least 1" })), "error": ValidationError }).annotate({ "identifier": "ValidationErrorResponse" })
export type ErrorResponse = { readonly "message": string, readonly "error": ErrorInfo }
export const ErrorResponse = Schema.Struct({ "message": Schema.String.check(Schema.isMinLength(1).annotate({ "expected": "a value with a length of at least 1" })), "error": ErrorInfo }).annotate({ "identifier": "ErrorResponse" })
export type BatchPostEntryResult = { readonly "idempotency_key": IdempotencyKey, readonly "status": "created" | "existing" | "rejected", readonly "journal_ref": JournalRef, readonly "error": BatchEntryError }
export const BatchPostEntryResult = Schema.Struct({ "idempotency_key": IdempotencyKey, "status": Schema.Literals(["created", "existing", "rejected"]), "journal_ref": JournalRef, "error": BatchEntryError }).annotate({ "identifier": "BatchPostEntryResult" })
export type GetAccountStatementResponse = { readonly "account": StatementAccount, readonly "period": StatementPeriod, readonly "opening_balance": number, readonly "closing_balance": number, readonly "entries": ReadonlyArray<StatementMovement>, readonly "page": StatementPage }
export const GetAccountStatementResponse = Schema.Struct({ "account": StatementAccount, "period": StatementPeriod, "opening_balance": Schema.Number.annotate({ "description": "Posted balance before the requested period in minor units.", "examples": [0], "format": "int64" }).check(Schema.isInt().annotate({ "expected": "an integer" })), "closing_balance": Schema.Number.annotate({ "description": "Posted balance at the end of the requested period in minor units.", "examples": [9600], "format": "int64" }).check(Schema.isInt().annotate({ "expected": "an integer" })), "entries": Schema.Array(StatementMovement), "page": StatementPage }).annotate({ "identifier": "GetAccountStatementResponse" })
export type BatchPostEntriesRequest = { readonly "ledger": LedgerSlug, readonly "entries": ReadonlyArray<BatchPostEntryItem> } & { readonly [x: string]: Schema.Json }
export const BatchPostEntriesRequest = Schema.StructWithRest(Schema.Struct({ "ledger": LedgerSlug, "entries": Schema.Array(BatchPostEntryItem).annotate({ "description": "Setting up a batch costs about what ten single postings cost, so a smaller batch is slower than posting the same entries to /entries one at a time. Send fewer than ten there instead." }).check(Schema.isMinLength(10).annotate({ "expected": "a value with a length of at least 10" })).check(Schema.isMaxLength(1000).annotate({ "expected": "a value with a length of at most 1000" })) }), [Schema.Record(Schema.String, Schema.Json.annotate({ "expected": "JSON value" }))]).annotate({ "identifier": "BatchPostEntriesRequest" })
export type BatchPostEntriesResponse = { readonly "results": ReadonlyArray<BatchPostEntryResult> }
export const BatchPostEntriesResponse = Schema.Struct({ "results": Schema.Array(BatchPostEntryResult) }).annotate({ "identifier": "BatchPostEntriesResponse" })
// schemas
export type GetHealth200 = HealthResponse
export const GetHealth200 = HealthResponse
export type CreatePayableAccountRequestJson = CreatePayableAccountRequest
export const CreatePayableAccountRequestJson = CreatePayableAccountRequest
export type CreatePayableAccount200 = CreatePayableAccountResponse
export const CreatePayableAccount200 = CreatePayableAccountResponse
export type CreatePayableAccount201 = CreatePayableAccountResponse
export const CreatePayableAccount201 = CreatePayableAccountResponse
export type CreatePayableAccount400 = ValidationErrorResponse
export const CreatePayableAccount400 = ValidationErrorResponse
export type CreatePayableAccount409 = ErrorResponse
export const CreatePayableAccount409 = ErrorResponse
export type CreatePayableAccount500 = ErrorResponse
export const CreatePayableAccount500 = ErrorResponse
export type GetAccount200 = GetAccountResponse
export const GetAccount200 = GetAccountResponse
export type GetAccount400 = ValidationErrorResponse
export const GetAccount400 = ValidationErrorResponse
export type GetAccount404 = ErrorResponse
export const GetAccount404 = ErrorResponse
export type GetAccount500 = ErrorResponse
export const GetAccount500 = ErrorResponse
export type GetAccountStatementParams = { readonly "from"?: string, readonly "to"?: string, readonly "limit"?: number, readonly "cursor"?: string }
export const GetAccountStatementParams = Schema.Struct({ "from": Schema.optionalKey(Schema.String.annotate({ "format": "date-time" })), "to": Schema.optionalKey(Schema.String.annotate({ "format": "date-time" })), "limit": Schema.optionalKey(Schema.Number.annotate({ "default": 50 }).check(Schema.isInt().annotate({ "expected": "an integer" })).check(Schema.isGreaterThanOrEqualTo(1).annotate({ "expected": "a value greater than or equal to 1" })).check(Schema.isLessThanOrEqualTo(100).annotate({ "expected": "a value less than or equal to 100" }))), "cursor": Schema.optionalKey(Schema.String) })
export type GetAccountStatement200 = GetAccountStatementResponse
export const GetAccountStatement200 = GetAccountStatementResponse
export type GetAccountStatement400 = ValidationErrorResponse
export const GetAccountStatement400 = ValidationErrorResponse
export type GetAccountStatement404 = ErrorResponse
export const GetAccountStatement404 = ErrorResponse
export type GetAccountStatement500 = ErrorResponse
export const GetAccountStatement500 = ErrorResponse
export type PostJournalEntryParams = { readonly "Idempotency-Key": IdempotencyKey }
export const PostJournalEntryParams = Schema.Struct({ "Idempotency-Key": IdempotencyKey })
export type PostJournalEntryRequestJson = PostJournalEntryRequest
export const PostJournalEntryRequestJson = PostJournalEntryRequest
export type PostJournalEntry200 = PostJournalEntryResponse
export const PostJournalEntry200 = PostJournalEntryResponse
export type PostJournalEntry201 = PostJournalEntryResponse
export const PostJournalEntry201 = PostJournalEntryResponse
export type PostJournalEntry400 = ValidationErrorResponse
export const PostJournalEntry400 = ValidationErrorResponse
export type PostJournalEntry404 = ErrorResponse
export const PostJournalEntry404 = ErrorResponse
export type PostJournalEntry409 = ErrorResponse
export const PostJournalEntry409 = ErrorResponse
export type PostJournalEntry500 = ErrorResponse
export const PostJournalEntry500 = ErrorResponse
export type PostJournalEntriesBatchRequestJson = BatchPostEntriesRequest
export const PostJournalEntriesBatchRequestJson = BatchPostEntriesRequest
export type PostJournalEntriesBatch200 = BatchPostEntriesResponse
export const PostJournalEntriesBatch200 = BatchPostEntriesResponse
export type PostJournalEntriesBatch400 = ValidationErrorResponse
export const PostJournalEntriesBatch400 = ValidationErrorResponse
export type PostJournalEntriesBatch404 = ErrorResponse
export const PostJournalEntriesBatch404 = ErrorResponse
export type PostJournalEntriesBatch409 = ErrorResponse
export const PostJournalEntriesBatch409 = ErrorResponse
export type PostJournalEntriesBatch500 = ErrorResponse
export const PostJournalEntriesBatch500 = ErrorResponse

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
): LedgerClient => {
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
        (cause) => Effect.fail(LedgerClientError(tag, cause, response)),
      )
  return {
    httpClient,
    "getHealth": (options) => HttpClientRequest.get("/health").pipe(
      withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetHealth200),
      orElse: unexpectedStatus
    }))
    ),
    "createPayableAccount": (options) => HttpClientRequest.post("/accounts").pipe(
      HttpClientRequest.bodyJsonUnsafe(options.payload),
      withResponse(options.config)(HttpClientResponse.matchStatus({
      "200": decodeSuccess(CreatePayableAccount200),
      "201": decodeSuccess(CreatePayableAccount201),
      "400": decodeError("CreatePayableAccount400", CreatePayableAccount400),
      "409": decodeError("CreatePayableAccount409", CreatePayableAccount409),
      "500": decodeError("CreatePayableAccount500", CreatePayableAccount500),
      orElse: unexpectedStatus
    }))
    ),
    "getAccount": (accountReference, options) => __makePathRequest(HttpClientRequest.get, [accountReference], () => "/accounts/" + __encodePathParam(accountReference) + "").pipe(
    Effect.flatMap((request) => request.pipe(
      withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetAccount200),
      "400": decodeError("GetAccount400", GetAccount400),
      "404": decodeError("GetAccount404", GetAccount404),
      "500": decodeError("GetAccount500", GetAccount500),
      orElse: unexpectedStatus
    }))
    ))
  ),
    "getAccountStatement": (accountReference, options) => __makePathRequest(HttpClientRequest.get, [accountReference], () => "/accounts/" + __encodePathParam(accountReference) + "/statement").pipe(
    Effect.flatMap((request) => request.pipe(
      HttpClientRequest.setUrlParams({ "from": options?.params?.["from"] as any, "to": options?.params?.["to"] as any, "limit": options?.params?.["limit"] as any, "cursor": options?.params?.["cursor"] as any }),
      withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetAccountStatement200),
      "400": decodeError("GetAccountStatement400", GetAccountStatement400),
      "404": decodeError("GetAccountStatement404", GetAccountStatement404),
      "500": decodeError("GetAccountStatement500", GetAccountStatement500),
      orElse: unexpectedStatus
    }))
    ))
  ),
    "postJournalEntry": (options) => HttpClientRequest.post("/entries").pipe(
      HttpClientRequest.setHeaders({ "Idempotency-Key": options.params["Idempotency-Key"] ?? undefined }),
      HttpClientRequest.bodyJsonUnsafe(options.payload),
      withResponse(options.config)(HttpClientResponse.matchStatus({
      "200": decodeSuccess(PostJournalEntry200),
      "201": decodeSuccess(PostJournalEntry201),
      "400": decodeError("PostJournalEntry400", PostJournalEntry400),
      "404": decodeError("PostJournalEntry404", PostJournalEntry404),
      "409": decodeError("PostJournalEntry409", PostJournalEntry409),
      "500": decodeError("PostJournalEntry500", PostJournalEntry500),
      orElse: unexpectedStatus
    }))
    ),
    "postJournalEntriesBatch": (options) => HttpClientRequest.post("/entries/batch").pipe(
      HttpClientRequest.bodyJsonUnsafe(options.payload),
      withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(PostJournalEntriesBatch200),
      "400": decodeError("PostJournalEntriesBatch400", PostJournalEntriesBatch400),
      "404": decodeError("PostJournalEntriesBatch404", PostJournalEntriesBatch404),
      "409": decodeError("PostJournalEntriesBatch409", PostJournalEntriesBatch409),
      "500": decodeError("PostJournalEntriesBatch500", PostJournalEntriesBatch500),
      orElse: unexpectedStatus
    }))
    )
  }
}

export interface LedgerClient {
  readonly httpClient: HttpClient.HttpClient
  /**
* Check whether the service is running
*/
readonly "getHealth": <Config extends OperationConfig>(options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetHealth200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Create a payable account in a ledger
*/
readonly "createPayableAccount": <Config extends OperationConfig>(options: { readonly payload: typeof CreatePayableAccountRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof CreatePayableAccount200.Type | typeof CreatePayableAccount201.Type, Config>, HttpClientError.HttpClientError | SchemaError | LedgerClientError<"CreatePayableAccount400", typeof CreatePayableAccount400.Type> | LedgerClientError<"CreatePayableAccount409", typeof CreatePayableAccount409.Type> | LedgerClientError<"CreatePayableAccount500", typeof CreatePayableAccount500.Type>>
  /**
* Retrieves one payable account and exposes both its derived available amount and its underlying ledger counters. This API does not expose internal cash or revenue accounts.
*/
readonly "getAccount": <Config extends OperationConfig>(accountReference: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetAccount200.Type, Config>, HttpClientError.HttpClientError | SchemaError | LedgerClientError<"GetAccount400", typeof GetAccount400.Type> | LedgerClientError<"GetAccount404", typeof GetAccount404.Type> | LedgerClientError<"GetAccount500", typeof GetAccount500.Type>>
  /**
* Retrieves the journal movements affecting one payable account within a recorded-time period, in the order they were applied to the account (`recorded_at, sequence`).
* 
* ### Example movements
* 
* | Recorded at | Journal reference | Kind | Direction | Amount | Balance |
* | --- | --- | --- | --- | ---: | ---: |
* | 2026-09-10 09:15 | `jrn_01M20J1QD2XB8K7G4N9CVF6T3A` | payment | Credit | 9,800 | 9,800 |
* | 2026-09-10 09:15 | `jrn_01M20J1QD2XB8K7G4N9CVF6T3A` | payment | Debit | 200 | 9,600 |
*/
readonly "getAccountStatement": <Config extends OperationConfig>(accountReference: string, options: { readonly params?: typeof GetAccountStatementParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetAccountStatement200.Type, Config>, HttpClientError.HttpClientError | SchemaError | LedgerClientError<"GetAccountStatement400", typeof GetAccountStatement400.Type> | LedgerClientError<"GetAccountStatement404", typeof GetAccountStatement404.Type> | LedgerClientError<"GetAccountStatement500", typeof GetAccountStatement500.Type>>
  /**
* Post a journal entry to a ledger
*/
readonly "postJournalEntry": <Config extends OperationConfig>(options: { readonly params: typeof PostJournalEntryParams.Encoded; readonly payload: typeof PostJournalEntryRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof PostJournalEntry200.Type | typeof PostJournalEntry201.Type, Config>, HttpClientError.HttpClientError | SchemaError | LedgerClientError<"PostJournalEntry400", typeof PostJournalEntry400.Type> | LedgerClientError<"PostJournalEntry404", typeof PostJournalEntry404.Type> | LedgerClientError<"PostJournalEntry409", typeof PostJournalEntry409.Type> | LedgerClientError<"PostJournalEntry500", typeof PostJournalEntry500.Type>>
  /**
* Each entry carries its own idempotency key in the body, rather than the request carrying one in an `Idempotency-Key` header as `POST /entries` does: a batch holds many independently retryable entries, and a header can only scope to the request. This endpoint takes no `Idempotency-Key` header, and one sent with the request is ignored.
* 
* The batch itself is therefore not idempotent; its entries are. Resending an identical batch is safe, and returns `existing` for whatever committed and `created` for the rest.
*/
readonly "postJournalEntriesBatch": <Config extends OperationConfig>(options: { readonly payload: typeof PostJournalEntriesBatchRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof PostJournalEntriesBatch200.Type, Config>, HttpClientError.HttpClientError | SchemaError | LedgerClientError<"PostJournalEntriesBatch400", typeof PostJournalEntriesBatch400.Type> | LedgerClientError<"PostJournalEntriesBatch404", typeof PostJournalEntriesBatch404.Type> | LedgerClientError<"PostJournalEntriesBatch409", typeof PostJournalEntriesBatch409.Type> | LedgerClientError<"PostJournalEntriesBatch500", typeof PostJournalEntriesBatch500.Type>>
}

export interface LedgerClientError<Tag extends string, E> {
  readonly _tag: Tag
  readonly request: HttpClientRequest.HttpClientRequest
  readonly response: HttpClientResponse.HttpClientResponse
  readonly cause: E
}

class LedgerClientErrorImpl extends Data.Error<{
  _tag: string
  cause: any
  request: HttpClientRequest.HttpClientRequest
  response: HttpClientResponse.HttpClientResponse
}> {}

export const LedgerClientError = <Tag extends string, E>(
  tag: Tag,
  cause: E,
  response: HttpClientResponse.HttpClientResponse,
): LedgerClientError<Tag, E> =>
  new LedgerClientErrorImpl({
    _tag: tag,
    cause,
    response,
    request: response.request,
  }) as any
