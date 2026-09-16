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

const (
	defaultStatementPeriod = 30 * 24 * time.Hour
	maxStatementPeriod     = 90 * 24 * time.Hour
)

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
	return api.Active
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

		lines[i] = journal.LineInput{
			DebitAccountReference:  line.DebitAccountRef,
			CreditAccountReference: line.CreditAccountRef,
			Amount:                 line.Amount,
			Purpose:                strings.TrimSpace(line.Purpose),
		}
	}

	description := strings.TrimSpace(request.Body.Description)

	result, err := s.service.PostEntry(ctx, journal.PostInput{
		LedgerSlug:  request.Body.Ledger,
		RequestID:   request.Params.IdempotencyKey,
		Kind:        journal.Kind(strings.TrimSpace(request.Body.Kind)),
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
		Kind:        api.JournalEntryKind(result.Entry.Kind),
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
			Message: "Idempotency key conflicts with a previous request.",
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
		from   time.Time
		to     time.Time
		cursor *statement.Cursor
	)

	limit := 50
	if request.Params.Limit != nil {
		limit = *request.Params.Limit
	}

	if request.Params.Cursor != nil && *request.Params.Cursor != "" {
		decCursor, boundPeriod, err := statement.DecodeCursor(*request.Params.Cursor)
		if err != nil {
			return statementValidationResponse(api.Query, "cursor", "invalid pagination cursor"), nil
		}
		if boundPeriod.To.Sub(boundPeriod.From) > maxStatementPeriod {
			return statementValidationResponse(api.Query, "cursor", "invalid pagination cursor"), nil
		}
		cursor = decCursor
		from = boundPeriod.From
		to = boundPeriod.To
	} else {
		if request.Params.To != nil {
			to = request.Params.To.UTC()
		} else {
			to = time.Now().UTC()
		}

		if request.Params.From != nil {
			from = request.Params.From.UTC()
		} else {
			from = to.Add(-defaultStatementPeriod)
		}

		if !from.Before(to) {
			return statementValidationResponse(api.Query, "from", "from must be before to"), nil
		}

		if to.Sub(from) > maxStatementPeriod {
			return statementValidationResponse(api.Query, "from", "statement period must not exceed 90 days"), nil
		}
	}

	result, err := s.service.GetStatement(ctx, statement.ListInput{
		AccountReference: request.AccountReference,
		From:             from,
		To:               to,
		Limit:            limit,
		Cursor:           cursor,
	})
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
			Kind:             api.JournalEntryKind(m.Kind),
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
