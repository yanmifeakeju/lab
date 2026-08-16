// Package httpapi implements the ledger's HTTP transport using the generated
// OpenAPI contract.
package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	"github.com/getkin/kin-openapi/openapi3filter"
	nethttpmiddleware "github.com/oapi-codegen/nethttp-middleware"

	"yanmifeakeju.com/ledger/internal/account"
	"yanmifeakeju.com/ledger/internal/api"
)

type PayableAccountCreator interface {
	CreatePayableAccount(context.Context, account.CreatePayableInput) (account.CreateResult, error)
}

// server implements the generated strict OpenAPI server interface. It stays
// private because callers only need the fully configured http.Handler returned
// by NewHandler.
type server struct {
	accounts PayableAccountCreator
}

var _ api.StrictServerInterface = (*server)(nil)

// NewHandler constructs the complete HTTP API, including routing, strict
// request/response handling, and OpenAPI request validation.
func NewHandler(accounts PayableAccountCreator) (http.Handler, error) {
	if accounts == nil {
		return nil, errors.New("httpapi: payable account creator is required")
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

	strict := api.NewStrictHandlerWithOptions(&server{accounts: accounts}, nil, api.StrictHTTPServerOptions{
		RequestErrorHandlerFunc:  writeRequestError,
		ResponseErrorHandlerFunc: writeResponseError,
	})
	mux := http.NewServeMux()
	api.HandlerWithOptions(strict, api.StdHTTPServerOptions{
		BaseRouter:  mux,
		Middlewares: []api.MiddlewareFunc{api.MiddlewareFunc(validateRequest)},
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
		LedgerSlug: request.Slug,
		ExternalID: request.Body.ExternalID,
		Name:       request.Body.Name,
	}
	result, err := s.accounts.CreatePayableAccount(ctx, input)
	if err != nil {
		return mapCreatePayableAccountError(err), nil
	}

	response := api.CreatePayableAccountResponse{
		LedgerSlug: request.Slug,
		ExternalID: input.ExternalID,
		Name:       result.Account.HolderName,
		CreatedAt:  result.Account.CreatedAt,
	}

	if result.Created {
		return api.CreatePayableAccount201JSONResponse(response), nil
	}

	return api.CreatePayableAccount200JSONResponse(response), nil
}

func mapCreatePayableAccountError(err error) api.CreatePayableAccountResponseObject {
	switch {
	case errors.Is(err, account.ErrLedgerNotFound):
		return api.CreatePayableAccount404JSONResponse{
			Message: "Ledger not found.",
			Error: api.ErrorInfo{
				Code: api.LedgerNotFound,
			},
		}

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
