package httpapi

import (
	"context"
	"errors"
	"fmt"

	"paytty.akeju.me/ledger/internal/api"
	"paytty.akeju.me/ledger/internal/journal"
)

// ResolveJournalEntry captures or voids a pending entry, or returns the
// existing resolution when the idempotency key identifies an identical request.
func (s *server) ResolveJournalEntry(
	ctx context.Context,
	request api.ResolveJournalEntryRequestObject,
) (api.ResolveJournalEntryResponseObject, error) {
	result, err := s.service.ResolveEntry(ctx, journal.ResolveInput{
		LedgerSlug:       request.Body.Ledger,
		RequestID:        request.Params.IdempotencyKey,
		PendingReference: request.JournalRef,
		Action:           journal.Action(request.Body.Action),
	})
	if err != nil {
		return mapResolveJournalEntryError(err), nil
	}

	r := result.Resolution
	response := api.ResolveJournalEntryResponse{
		JournalRef:   r.Reference,
		PendingRef:   r.PendingReference,
		LedgerSlug:   request.Body.Ledger,
		Kind:         r.Kind,
		PendingState: api.EntryState(r.PendingState),
		Description:  r.Description,
		CreatedAt:    r.CreatedAt,
	}
	if result.Created {
		return api.ResolveJournalEntry201JSONResponse(response), nil
	}
	return api.ResolveJournalEntry200JSONResponse(response), nil
}

func mapResolveJournalEntryError(err error) api.ResolveJournalEntryResponseObject {
	conflict := func(message string, code api.ErrorCode) api.ResolveJournalEntry409JSONResponse {
		return api.ResolveJournalEntry409JSONResponse{Message: message, Error: api.ErrorInfo{Code: code}}
	}

	if resolved, ok := errors.AsType[*journal.ResolvedError](err); ok {
		state := api.EntryState(resolved.PendingState)
		winner := resolved.ResolutionReference
		response := conflict(fmt.Sprintf("Entry is already %s.", resolved.PendingState), api.EntryResolved)
		response.PendingState = &state
		response.ResolvedBy = &winner
		return response
	}

	switch {
	case errors.Is(err, journal.ErrLedgerNotFound):
		return api.ResolveJournalEntry400JSONResponse{
			InvalidRequestJSONResponse: api.InvalidRequestJSONResponse(newValidationResponse([]api.ValidationErrorDetail{{
				Location: api.Body,
				Field:    "ledger",
				Code:     api.InvalidValue,
				Message:  msgUnknownLedger,
			}})),
		}
	case errors.Is(err, journal.ErrEntryNotFound):
		return api.ResolveJournalEntry404JSONResponse{
			Message: "Entry not found.",
			Error:   api.ErrorInfo{Code: api.EntryNotFound},
		}
	case errors.Is(err, journal.ErrEntryNotPending):
		return conflict("Entry was posted immediately and has nothing to resolve.", api.EntryNotPending)
	case errors.Is(err, journal.ErrIdempotencyConflict):
		return conflict("Idempotency key was previously used with different content.", api.IdempotencyConflict)
	default:
		return api.ResolveJournalEntry500JSONResponse{
			Message: "The server could not complete the request.",
			Error:   api.ErrorInfo{Code: api.InternalServerError},
		}
	}
}

// ResolveJournalEntriesBatch resolves between MinBatchEntries and
// MaxBatchEntries pending entries in one transaction.
func (s *server) ResolveJournalEntriesBatch(
	ctx context.Context,
	request api.ResolveJournalEntriesBatchRequestObject,
) (api.ResolveJournalEntriesBatchResponseObject, error) {
	if request.Body == nil || len(request.Body.Items) < journal.MinBatchEntries {
		return resolveBatchValidationResponse("items", fmt.Sprintf(
			"items must contain at least %d items; resolve fewer than that one at a time instead",
			journal.MinBatchEntries,
		)), nil
	}
	if len(request.Body.Items) > journal.MaxBatchEntries {
		return resolveBatchValidationResponse("items", fmt.Sprintf(
			"items must not contain more than %d items", journal.MaxBatchEntries,
		)), nil
	}

	seenKeys := make(map[string]struct{}, len(request.Body.Items))
	seenPending := make(map[string]struct{}, len(request.Body.Items))
	items := make([]journal.ResolveBatchItemInput, len(request.Body.Items))
	for i, item := range request.Body.Items {
		if _, dup := seenKeys[item.IdempotencyKey]; dup {
			return resolveBatchValidationResponse(
				fmt.Sprintf("items[%d].idempotency_key", i),
				"duplicate idempotency key within batch",
			), nil
		}
		seenKeys[item.IdempotencyKey] = struct{}{}

		if _, dup := seenPending[item.PendingRef]; dup {
			return resolveBatchValidationResponse(
				fmt.Sprintf("items[%d].pending_ref", i),
				"pending_ref must not repeat within batch",
			), nil
		}
		seenPending[item.PendingRef] = struct{}{}

		items[i] = journal.ResolveBatchItemInput{
			RequestID:        item.IdempotencyKey,
			PendingReference: item.PendingRef,
			Action:           journal.Action(item.Action),
		}
	}

	result, err := s.service.ResolveEntries(ctx, journal.ResolveBatchInput{
		LedgerSlug: request.Body.Ledger,
		Items:      items,
	})
	if err != nil {
		return mapResolveBatchError(err), nil
	}

	results := make([]api.BatchResolveEntryResult, len(result.Results))
	for i, r := range result.Results {
		var errInfo *api.BatchEntryError
		if r.Error != nil {
			errInfo = &api.BatchEntryError{Code: api.ErrorCode(r.Error.Code), Message: r.Error.Message}
		}
		var state *api.EntryState
		if r.PendingState != nil {
			st := api.EntryState(*r.PendingState)
			state = &st
		}
		results[i] = api.BatchResolveEntryResult{
			IdempotencyKey: r.RequestID,
			PendingRef:     r.PendingReference,
			Status:         api.BatchResolveEntryResultStatus(r.Status),
			JournalRef:     r.JournalRef,
			PendingState:   state,
			ResolvedBy:     r.ResolvedBy,
			Error:          errInfo,
		}
	}

	return api.ResolveJournalEntriesBatch200JSONResponse{Results: results}, nil
}

func mapResolveBatchError(err error) api.ResolveJournalEntriesBatchResponseObject {
	switch {
	case errors.Is(err, journal.ErrLedgerNotFound):
		return api.ResolveJournalEntriesBatch404JSONResponse{
			Message: "Ledger not found.",
			Error:   api.ErrorInfo{Code: api.LedgerNotFound},
		}
	case errors.Is(err, journal.ErrBatchTooSmall), errors.Is(err, journal.ErrNoLines):
		return resolveBatchValidationResponse("items", fmt.Sprintf(
			"items must contain at least %d items; resolve fewer than that one at a time instead",
			journal.MinBatchEntries,
		))
	case errors.Is(err, journal.ErrBatchSizeExceeded):
		return resolveBatchValidationResponse("items", fmt.Sprintf(
			"items must not contain more than %d items", journal.MaxBatchEntries,
		))
	case errors.Is(err, journal.ErrIdempotencyConflict):
		return resolveBatchValidationResponse("items", "duplicate idempotency key within batch")
	case errors.Is(err, journal.ErrDuplicatePendingReference):
		return resolveBatchValidationResponse("items", "pending_ref must not repeat within batch")
	default:
		return api.ResolveJournalEntriesBatch500JSONResponse{
			Message: "The server could not complete the request.",
			Error:   api.ErrorInfo{Code: api.InternalServerError},
		}
	}
}

func resolveBatchValidationResponse(field, message string) api.ResolveJournalEntriesBatch400JSONResponse {
	return api.ResolveJournalEntriesBatch400JSONResponse{
		InvalidRequestJSONResponse: api.InvalidRequestJSONResponse(
			newValidationResponse([]api.ValidationErrorDetail{{
				Location: api.Body,
				Field:    field,
				Code:     api.InvalidValue,
				Message:  message,
			}}),
		),
	}
}
