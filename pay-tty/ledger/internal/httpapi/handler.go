// Package httpapi implements the ledger's HTTP transport using the generated
// OpenAPI contract.
package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/getkin/kin-openapi/openapi3filter"
	nethttpmiddleware "github.com/oapi-codegen/nethttp-middleware"

	"yanmifeakeju.com/ledger/internal/account"
	"yanmifeakeju.com/ledger/internal/api"
	"yanmifeakeju.com/ledger/internal/journal"
	"yanmifeakeju.com/ledger/internal/statement"
)

type PayableAccountCreator interface {
	CreatePayableAccount(context.Context, account.CreatePayableInput) (account.CreateResult, error)
}

type PayableAccountGetter interface {
	GetPayableAccount(context.Context, account.GetPayableInput) (account.Payable, error)
}

type JournalEntryPoster interface {
	PostEntry(context.Context, journal.PostInput) (journal.PostResult, error)
	PostEntries(context.Context, journal.BatchInput) (journal.BatchResult, error)
}

type StatementGetter interface {
	GetStatement(context.Context, statement.ListInput) (statement.Result, error)
}

// Service provides the application operations exposed by the HTTP API.
type Service interface {
	PayableAccountCreator
	PayableAccountGetter
	JournalEntryPoster
	StatementGetter
}

const msgUnknownLedger = "ledger must name an existing ledger"

// server implements the generated strict OpenAPI server interface. It stays
// private because callers only need the fully configured http.Handler returned
// by NewHandler.
type server struct {
	service Service
}

var _ api.StrictServerInterface = (*server)(nil)

// NewHandler constructs the complete HTTP API, including routing, strict
// request/response handling, and OpenAPI request validation.
func NewHandler(service Service) (http.Handler, error) {
	if service == nil {
		return nil, errors.New("httpapi: service is required")
	}

	spec, err := api.GetSpec()
	if err != nil {
		return nil, fmt.Errorf("load embedded OpenAPI specification: %w", err)
	}
	if err := spec.Validate(context.Background()); err != nil {
		return nil, fmt.Errorf("validate embedded OpenAPI specification: %w", err)
	}

	validateRequest := nethttpmiddleware.OapiRequestValidatorWithOptions(
		spec,
		&nethttpmiddleware.Options{
			Options: openapi3filter.Options{
				MultiError: true,
			},
			ErrorHandlerWithOpts: writeValidationError,
		},
	)

	strict := api.NewStrictHandlerWithOptions(&server{service: service}, nil, api.StrictHTTPServerOptions{
		RequestErrorHandlerFunc:  writeRequestError,
		ResponseErrorHandlerFunc: writeResponseError,
	})
	mux := http.NewServeMux()
	api.HandlerWithOptions(strict, api.StdHTTPServerOptions{
		BaseRouter:       mux,
		Middlewares:      []api.MiddlewareFunc{api.MiddlewareFunc(validateRequest)},
		ErrorHandlerFunc: writeParameterError,
	})

	return mux, nil
}

// GetHealth implements api.StrictServerInterface.
func (s *server) GetHealth(context.Context, api.GetHealthRequestObject) (api.GetHealthResponseObject, error) {
	return api.GetHealth200JSONResponse{Status: "ok"}, nil
}

// CreatePayableAccount creates or returns a payable account for a ledger.
// OpenAPI validation runs before this method is called.
func (s *server) CreatePayableAccount(
	ctx context.Context,
	request api.CreatePayableAccountRequestObject,
) (api.CreatePayableAccountResponseObject, error) {
	input := account.CreatePayableInput{
		LedgerSlug: request.Body.Ledger,
		ExternalID: request.Body.ExternalID,
		Name:       strings.TrimSpace(request.Body.Name),
	}
	result, err := s.service.CreatePayableAccount(ctx, input)
	if err != nil {
		return mapCreatePayableAccountError(err), nil
	}

	response := api.CreatePayableAccountResponse{
		Reference:       result.Account.Reference,
		HolderReference: result.Account.HolderReference,
		LedgerSlug:      request.Body.Ledger,
		ExternalID:      input.ExternalID,
		Name:            result.Account.HolderName,
		Kind:            api.Payable,
		Status:          payableAccountStatus(result.Account.ClosedAt),
		ClosedAt:        result.Account.ClosedAt,
		Available:       int64(result.Account.Available()),
		Balances: api.AccountBalances{
			DebitsPending:  result.Account.Balances.DebitsPending,
			CreditsPending: result.Account.Balances.CreditsPending,
			DebitsPosted:   result.Account.Balances.DebitsPosted,
			CreditsPosted:  result.Account.Balances.CreditsPosted,
		},
		CreatedAt: result.Account.CreatedAt,
	}

	if result.Created {
		return api.CreatePayableAccount201JSONResponse(response), nil
	}

	return api.CreatePayableAccount200JSONResponse(response), nil
}

// GetAccount retrieves a payable account and its ledger balances.
func (s *server) GetAccount(
	ctx context.Context,
	request api.GetAccountRequestObject,
) (api.GetAccountResponseObject, error) {
	result, err := s.service.GetPayableAccount(ctx, account.GetPayableInput{
		Reference: request.AccountReference,
	})
	if err != nil {
		return mapGetAccountError(err), nil
	}

	response := api.GetAccountResponse{
		Reference:       result.Reference,
		HolderReference: result.HolderReference,
		LedgerSlug:      result.LedgerSlug,
		Kind:            api.Payable,
		Name:            result.HolderName,
		Status:          payableAccountStatus(result.ClosedAt),
		ClosedAt:        result.ClosedAt,
		Available:       int64(result.Available()),
		Balances: api.AccountBalances{
			DebitsPending:  result.Balances.DebitsPending,
			CreditsPending: result.Balances.CreditsPending,
			DebitsPosted:   result.Balances.DebitsPosted,
			CreditsPosted:  result.Balances.CreditsPosted,
		},
		CreatedAt: result.CreatedAt,
	}

	return api.GetAccount200JSONResponse(response), nil
}

func payableAccountStatus(closedAt *time.Time) api.AccountStatus {
	if closedAt != nil && !closedAt.After(time.Now()) {
		return api.Closed
	}
	return api.Open
}

// PostJournalEntry posts an immediate journal entry or returns the existing
// entry when the idempotency key identifies an identical request.
func (s *server) PostJournalEntry(
	ctx context.Context,
	request api.PostJournalEntryRequestObject,
) (api.PostJournalEntryResponseObject, error) {
	lines := make([]journal.LineInput, len(request.Body.Lines))
	for i, line := range request.Body.Lines {
		if line.DebitAccountRef == line.CreditAccountRef {
			return postJournalEntryValidationResponse(
				fmt.Sprintf("lines[%d]", i),
				"debit_account_ref and credit_account_ref must differ",
			), nil
		}

		purpose := strings.TrimSpace(line.Purpose)
		if purpose == "" {
			return postJournalEntryValidationResponse(
				fmt.Sprintf("lines[%d].purpose", i),
				"purpose must not be blank",
			), nil
		}

		lines[i] = journal.LineInput{
			DebitAccountReference:  line.DebitAccountRef,
			CreditAccountReference: line.CreditAccountRef,
			Amount:                 line.Amount,
			Purpose:                purpose,
		}
	}

	kind := strings.TrimSpace(request.Body.Kind)
	if kind == "" {
		return postJournalEntryValidationResponse(
			"kind",
			"kind must not be blank",
		), nil
	}

	description := strings.TrimSpace(request.Body.Description)
	if description == "" {
		return postJournalEntryValidationResponse(
			"description",
			"description must not be blank",
		), nil
	}

	result, err := s.service.PostEntry(ctx, journal.PostInput{
		LedgerSlug:  request.Body.Ledger,
		RequestID:   request.Params.IdempotencyKey,
		Kind:        kind,
		Description: description,
		EffectiveAt: request.Body.EffectiveAt,
		Lines:       lines,
	})
	if err != nil {
		return mapPostJournalEntryError(err), nil
	}

	response := api.PostJournalEntryResponse{
		JournalRef:  result.Entry.Reference,
		LedgerSlug:  request.Body.Ledger,
		Kind:        result.Entry.Kind,
		State:       api.PostJournalEntryResponseState(result.Entry.State),
		Description: result.Entry.Description,
		EffectiveAt: result.Entry.EffectiveAt,
		CreatedAt:   result.Entry.CreatedAt,
	}
	if result.Created {
		return api.PostJournalEntry201JSONResponse(response), nil
	}

	return api.PostJournalEntry200JSONResponse(response), nil
}

// batchTooSmallMessage names the other endpoint, because the caller's fix is
// to change route, not to pad the batch.
func batchTooSmallMessage() string {
	return fmt.Sprintf(
		"entries must contain at least %d entries; post fewer than that to /entries instead",
		journal.MinBatchEntries,
	)
}

// PostJournalEntriesBatch posts between MinBatchEntries and MaxBatchEntries
// entries in one transaction.
func (s *server) PostJournalEntriesBatch(
	ctx context.Context,
	request api.PostJournalEntriesBatchRequestObject,
) (api.PostJournalEntriesBatchResponseObject, error) {
	if request.Body == nil || len(request.Body.Entries) < journal.MinBatchEntries {
		return postJournalEntriesBatchValidationResponse("entries", batchTooSmallMessage()), nil
	}

	if len(request.Body.Entries) > journal.MaxBatchEntries {
		return postJournalEntriesBatchValidationResponse("entries", fmt.Sprintf("entries must not contain more than %d entries", journal.MaxBatchEntries)), nil
	}

	totalLines := 0
	seenKeys := make(map[string]struct{}, len(request.Body.Entries))
	batchEntries := make([]journal.BatchItemInput, len(request.Body.Entries))

	for i, entry := range request.Body.Entries {
		key := entry.IdempotencyKey
		if _, exists := seenKeys[key]; exists {
			return postJournalEntriesBatchValidationResponse(
				fmt.Sprintf("entries[%d].idempotency_key", i),
				"duplicate idempotency key within batch",
			), nil
		}
		seenKeys[key] = struct{}{}

		if len(entry.Lines) == 0 {
			return postJournalEntriesBatchValidationResponse(
				fmt.Sprintf("entries[%d].lines", i),
				"entry must contain at least 1 line",
			), nil
		}

		kind := strings.TrimSpace(entry.Kind)
		if kind == "" {
			return postJournalEntriesBatchValidationResponse(
				fmt.Sprintf("entries[%d].kind", i),
				"kind must not be blank",
			), nil
		}

		description := strings.TrimSpace(entry.Description)
		if description == "" {
			return postJournalEntriesBatchValidationResponse(
				fmt.Sprintf("entries[%d].description", i),
				"description must not be blank",
			), nil
		}

		totalLines += len(entry.Lines)
		if totalLines > journal.MaxBatchLines {
			return postJournalEntriesBatchValidationResponse(
				"entries",
				fmt.Sprintf("batch exceeds maximum of %d lines", journal.MaxBatchLines),
			), nil
		}

		lines := make([]journal.LineInput, len(entry.Lines))
		for j, line := range entry.Lines {
			if line.DebitAccountRef == line.CreditAccountRef {
				return postJournalEntriesBatchValidationResponse(
					fmt.Sprintf("entries[%d].lines[%d]", i, j),
					"debit_account_ref and credit_account_ref must differ",
				), nil
			}

			purpose := strings.TrimSpace(line.Purpose)
			if purpose == "" {
				return postJournalEntriesBatchValidationResponse(
					fmt.Sprintf("entries[%d].lines[%d].purpose", i, j),
					"purpose must not be blank",
				), nil
			}

			lines[j] = journal.LineInput{
				DebitAccountReference:  line.DebitAccountRef,
				CreditAccountReference: line.CreditAccountRef,
				Amount:                 line.Amount,
				Purpose:                purpose,
			}
		}

		batchEntries[i] = journal.BatchItemInput{
			RequestID:   key,
			Kind:        kind,
			Description: description,
			EffectiveAt: entry.EffectiveAt,
			Lines:       lines,
		}
	}

	result, err := s.service.PostEntries(ctx, journal.BatchInput{
		LedgerSlug: request.Body.Ledger,
		Entries:    batchEntries,
	})
	if err != nil {
		return mapPostJournalEntriesBatchError(err), nil
	}

	results := make([]api.BatchPostEntryResult, len(result.Results))
	for i, r := range result.Results {
		var errInfo *api.BatchEntryError
		if r.Error != nil {
			errInfo = &api.BatchEntryError{
				Code:    api.ErrorCode(r.Error.Code),
				Message: r.Error.Message,
			}
		}

		results[i] = api.BatchPostEntryResult{
			IdempotencyKey: r.RequestID,
			Status:         api.BatchPostEntryResultStatus(r.Status),
			JournalRef:     r.JournalRef,
			Error:          errInfo,
		}
	}

	return api.PostJournalEntriesBatch200JSONResponse{Results: results}, nil
}

func mapPostJournalEntriesBatchError(err error) api.PostJournalEntriesBatchResponseObject {
	switch {
	case errors.Is(err, journal.ErrLedgerNotFound):
		return api.PostJournalEntriesBatch404JSONResponse{
			Message: "Ledger not found.",
			Error:   api.ErrorInfo{Code: api.LedgerNotFound},
		}
	case errors.Is(err, journal.ErrLedgerClosed):
		return api.PostJournalEntriesBatch409JSONResponse{
			Message: "Ledger is closed.",
			Error:   api.ErrorInfo{Code: api.LedgerClosed},
		}
	// Per-entry limit breaches come back as results, not errors. Reaching here
	// means an account CHECK failed the whole batch after the per-entry check
	// had passed, which is still a limit and not a server fault.
	case errors.Is(err, journal.ErrInsufficientFunds):
		return api.PostJournalEntriesBatch409JSONResponse{
			Message: "Insufficient funds.",
			Error:   api.ErrorInfo{Code: api.InsufficientFunds},
		}
	case errors.Is(err, journal.ErrNoLines):
		return postJournalEntriesBatchValidationResponse("entries", "entries must contain at least one journal line")
	case errors.Is(err, journal.ErrBatchTooSmall):
		return postJournalEntriesBatchValidationResponse("entries", batchTooSmallMessage())
	case errors.Is(err, journal.ErrBatchSizeExceeded):
		return postJournalEntriesBatchValidationResponse("entries", fmt.Sprintf("entries must not contain more than %d entries", journal.MaxBatchEntries))
	case errors.Is(err, journal.ErrBatchLinesExceeded):
		return postJournalEntriesBatchValidationResponse("entries", fmt.Sprintf("batch exceeds maximum of %d lines", journal.MaxBatchLines))
	case errors.Is(err, journal.ErrIdempotencyConflict):
		return postJournalEntriesBatchValidationResponse("entries", "duplicate idempotency key within batch")
	case errors.Is(err, journal.ErrNoSelfTransfer):
		return postJournalEntriesBatchValidationResponse("entries", "debit_account_ref and credit_account_ref must differ")
	case errors.Is(err, journal.ErrNonPositiveAmount):
		return postJournalEntriesBatchValidationResponse("entries", "line amounts must be greater than zero")
	case errors.Is(err, journal.ErrBlankDescription):
		return postJournalEntriesBatchValidationResponse("entries", "description must not be blank")
	case errors.Is(err, journal.ErrDescriptionTooLong):
		return postJournalEntriesBatchValidationResponse("entries", "description must not exceed 500 characters")
	case errors.Is(err, journal.ErrBlankKind):
		return postJournalEntriesBatchValidationResponse("entries", "kind must not be blank")
	case errors.Is(err, journal.ErrKindTooLong):
		return postJournalEntriesBatchValidationResponse("entries", "kind must not exceed 64 characters")
	case errors.Is(err, journal.ErrBlankPurpose):
		return postJournalEntriesBatchValidationResponse("entries", "line purposes must not be blank")
	case errors.Is(err, journal.ErrPurposeTooLong):
		return postJournalEntriesBatchValidationResponse("entries", "line purposes must not exceed 100 characters")
	default:
		return api.PostJournalEntriesBatch500JSONResponse{
			Message: "The server could not complete the request.",
			Error:   api.ErrorInfo{Code: api.InternalServerError},
		}
	}
}

func postJournalEntriesBatchValidationResponse(field, message string) api.PostJournalEntriesBatch400JSONResponse {
	return api.PostJournalEntriesBatch400JSONResponse{
		InvalidRequestJSONResponse: api.InvalidRequestJSONResponse(
			newValidationResponse([]api.ValidationErrorDetail{
				{
					Location: api.Body,
					Field:    field,
					Code:     api.InvalidValue,
					Message:  message,
				},
			}),
		),
	}
}

func mapCreatePayableAccountError(err error) api.CreatePayableAccountResponseObject {
	switch {
	case errors.Is(err, account.ErrLedgerNotFound):
		return createPayableAccountValidationResponse(
			"ledger",
			msgUnknownLedger,
		)

	case errors.Is(err, account.ErrLedgerClosed):
		return api.CreatePayableAccount409JSONResponse{
			Message: "Ledger is closed.",
			Error: api.ErrorInfo{
				Code: api.LedgerClosed,
			},
		}

	case errors.Is(err, account.ErrHolderConflict):
		return api.CreatePayableAccount409JSONResponse{
			Message: "Holder information conflicts with an existing holder.",
			Error: api.ErrorInfo{
				Code: api.HolderConflict,
			},
		}

	default:
		return api.CreatePayableAccount500JSONResponse{
			Message: "The server could not complete the request.",
			Error: api.ErrorInfo{
				Code: api.InternalServerError,
			},
		}
	}
}

func createPayableAccountValidationResponse(field, message string) api.CreatePayableAccount400JSONResponse {
	return api.CreatePayableAccount400JSONResponse{
		InvalidRequestJSONResponse: api.InvalidRequestJSONResponse(
			newValidationResponse([]api.ValidationErrorDetail{
				{
					Location: api.Body,
					Field:    field,
					Code:     api.InvalidValue,
					Message:  message,
				},
			}),
		),
	}
}

func mapGetAccountError(err error) api.GetAccountResponseObject {
	switch {
	case errors.Is(err, account.ErrAccountNotFound):
		return api.GetAccount404JSONResponse{
			Message: "Account not found.",
			Error: api.ErrorInfo{
				Code: api.AccountNotFound,
			},
		}

	default:
		return api.GetAccount500JSONResponse{
			Message: "The server could not complete the request.",
			Error: api.ErrorInfo{
				Code: api.InternalServerError,
			},
		}
	}
}

func mapPostJournalEntryError(err error) api.PostJournalEntryResponseObject {
	switch {
	case errors.Is(err, journal.ErrLedgerNotFound):
		return postJournalEntryValidationResponse(
			"ledger",
			msgUnknownLedger,
		)
	case errors.Is(err, journal.ErrAccountNotFound):
		return api.PostJournalEntry404JSONResponse{
			Message: "Account not found.",
			Error:   api.ErrorInfo{Code: api.AccountNotFound},
		}
	case errors.Is(err, journal.ErrLedgerClosed):
		return api.PostJournalEntry409JSONResponse{
			Message: "Ledger is closed.",
			Error:   api.ErrorInfo{Code: api.LedgerClosed},
		}
	case errors.Is(err, journal.ErrAccountClosed):
		return api.PostJournalEntry409JSONResponse{
			Message: "Account is closed.",
			Error:   api.ErrorInfo{Code: api.AccountClosed},
		}
	case errors.Is(err, journal.ErrInsufficientFunds):
		return api.PostJournalEntry409JSONResponse{
			Message: "Insufficient funds.",
			Error:   api.ErrorInfo{Code: api.InsufficientFunds},
		}
	case errors.Is(err, journal.ErrIdempotencyConflict):
		return api.PostJournalEntry409JSONResponse{
			Message: "Idempotency key was previously used with different content.",
			Error:   api.ErrorInfo{Code: api.IdempotencyConflict},
		}
	case errors.Is(err, journal.ErrNoLines):
		return postJournalEntryValidationResponse(
			"lines",
			"lines must contain at least one journal line",
		)
	case errors.Is(err, journal.ErrNoSelfTransfer):
		return postJournalEntryValidationResponse(
			"lines",
			"debit_account_ref and credit_account_ref must differ",
		)
	case errors.Is(err, journal.ErrNonPositiveAmount):
		return postJournalEntryValidationResponse(
			"lines",
			"line amounts must be greater than zero",
		)
	case errors.Is(err, journal.ErrBlankDescription):
		return postJournalEntryValidationResponse(
			"description",
			"description must not be blank",
		)
	case errors.Is(err, journal.ErrDescriptionTooLong):
		return postJournalEntryValidationResponse(
			"description",
			"description must not exceed 500 characters",
		)
	case errors.Is(err, journal.ErrBlankKind):
		return postJournalEntryValidationResponse(
			"kind",
			"kind must not be blank",
		)
	case errors.Is(err, journal.ErrKindTooLong):
		return postJournalEntryValidationResponse(
			"kind",
			"kind must not exceed 64 characters",
		)
	case errors.Is(err, journal.ErrBlankPurpose):
		return postJournalEntryValidationResponse(
			"lines",
			"line purposes must not be blank",
		)
	case errors.Is(err, journal.ErrPurposeTooLong):
		return postJournalEntryValidationResponse(
			"lines",
			"line purposes must not exceed 100 characters",
		)
	default:
		return api.PostJournalEntry500JSONResponse{
			Message: "The server could not complete the request.",
			Error:   api.ErrorInfo{Code: api.InternalServerError},
		}
	}
}

func postJournalEntryValidationResponse(field, message string) api.PostJournalEntry400JSONResponse {
	return api.PostJournalEntry400JSONResponse{
		InvalidRequestJSONResponse: api.InvalidRequestJSONResponse(
			newValidationResponse([]api.ValidationErrorDetail{
				{
					Location: api.Body,
					Field:    field,
					Code:     api.InvalidValue,
					Message:  message,
				},
			}),
		),
	}
}

// GetAccountStatement retrieves the journal movements affecting one payable account.
func (s *server) GetAccountStatement(
	ctx context.Context,
	request api.GetAccountStatementRequestObject,
) (api.GetAccountStatementResponseObject, error) {
	var (
		from   *time.Time
		to     *time.Time
		cursor *statement.Cursor
	)

	limit := 50
	if request.Params.Limit != nil {
		limit = *request.Params.Limit
	}

	// The store resolves defaults and the period checks against the database
	// clock, which also stamps the movements.
	if request.Params.Cursor != nil && *request.Params.Cursor != "" {
		decCursor, boundPeriod, err := statement.DecodeCursor(*request.Params.Cursor)
		if err != nil {
			return statementValidationResponse(api.Query, "cursor", "invalid pagination cursor"), nil
		}
		cursor = decCursor
		from = &boundPeriod.From
		to = &boundPeriod.To
	} else {
		if request.Params.From != nil {
			v := request.Params.From.UTC()
			from = &v
		}
		if request.Params.To != nil {
			v := request.Params.To.UTC()
			to = &v
		}
	}

	result, err := s.service.GetStatement(ctx, statement.ListInput{
		AccountReference: request.AccountReference,
		From:             from,
		To:               to,
		Limit:            limit,
		Cursor:           cursor,
	})
	if errors.Is(err, statement.ErrPeriodNotOrdered) || errors.Is(err, statement.ErrPeriodTooLong) {
		switch {
		case cursor != nil:
			return statementValidationResponse(api.Query, "cursor", "invalid pagination cursor"), nil
		case errors.Is(err, statement.ErrPeriodTooLong):
			return statementValidationResponse(api.Query, "from", "statement period must not exceed 90 days"), nil
		default:
			return statementValidationResponse(api.Query, "from", "from must be before to"), nil
		}
	}
	if err != nil {
		return mapGetAccountStatementError(err), nil
	}

	prevToken, err := statement.EncodeCursor(result.Page.Previous, result.Period)
	if err != nil {
		return api.GetAccountStatement500JSONResponse{
			Message: "The server could not complete the request.",
			Error:   api.ErrorInfo{Code: api.InternalServerError},
		}, nil
	}

	nextToken, err := statement.EncodeCursor(result.Page.Next, result.Period)
	if err != nil {
		return api.GetAccountStatement500JSONResponse{
			Message: "The server could not complete the request.",
			Error:   api.ErrorInfo{Code: api.InternalServerError},
		}, nil
	}

	entries := make([]api.StatementMovement, len(result.Movements))
	for i, m := range result.Movements {
		entries[i] = api.StatementMovement{
			JournalReference: m.JournalReference,
			LineNumber:       m.LineNumber,
			Kind:             m.Kind,
			Direction:        api.StatementDirection(m.Direction),
			Amount:           m.Amount,
			BalanceAfter:     m.BalanceAfter,
			Description:      m.Description,
			Purpose:          m.Purpose,
			RecordedAt:       m.RecordedAt,
		}
	}

	response := api.GetAccountStatementResponse{
		Account: api.StatementAccount{
			Reference:       result.Account.Reference,
			HolderReference: result.Account.HolderReference,
			Name:            result.Account.Name,
		},
		Period: api.StatementPeriod{
			From: result.Period.From,
			To:   result.Period.To,
		},
		OpeningBalance: result.OpeningBalance,
		ClosingBalance: result.ClosingBalance,
		Entries:        entries,
		Page: api.StatementPage{
			Limit:          result.Page.Limit,
			PreviousCursor: prevToken,
			NextCursor:     nextToken,
		},
	}

	return api.GetAccountStatement200JSONResponse(response), nil
}

func mapGetAccountStatementError(err error) api.GetAccountStatementResponseObject {
	switch {
	case errors.Is(err, account.ErrAccountNotFound):
		return api.GetAccountStatement404JSONResponse{
			Message: "Account not found.",
			Error: api.ErrorInfo{
				Code: api.AccountNotFound,
			},
		}
	default:
		return api.GetAccountStatement500JSONResponse{
			Message: "The server could not complete the request.",
			Error: api.ErrorInfo{
				Code: api.InternalServerError,
			},
		}
	}
}

func statementValidationResponse(location api.ValidationErrorDetailLocation, field, message string) api.GetAccountStatement400JSONResponse {
	return api.GetAccountStatement400JSONResponse{
		InvalidRequestJSONResponse: api.InvalidRequestJSONResponse(
			newValidationResponse([]api.ValidationErrorDetail{
				{
					Location: location,
					Field:    field,
					Code:     api.InvalidValue,
					Message:  message,
				},
			}),
		),
	}
}
