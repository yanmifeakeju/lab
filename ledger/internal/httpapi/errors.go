package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"

	"github.com/getkin/kin-openapi/openapi3"
	"github.com/getkin/kin-openapi/openapi3filter"
	nethttpmiddleware "github.com/oapi-codegen/nethttp-middleware"

	"yanmifeakeju.com/ledger/internal/api"
)

type errorResponse struct {
	Error   string `json:"error"`
	Message string `json:"message"`
}

func writeValidationError(
	_ context.Context,
	err error,
	w http.ResponseWriter,
	_ *http.Request,
	opts nethttpmiddleware.ErrorHandlerOpts,
) {
	if opts.StatusCode != http.StatusBadRequest {
		writeError(w, opts.StatusCode, errorResponse{
			Error:   http.StatusText(opts.StatusCode),
			Message: http.StatusText(opts.StatusCode),
		})
		return
	}

	writeValidationResponse(w, validationErrorDetails(err))
}

func writeRequestError(w http.ResponseWriter, _ *http.Request, _ error) {
	writeValidationResponse(w, []api.ValidationErrorDetail{
		{
			Location: api.Body,
			Field:    "body",
			Code:     api.InvalidFormat,
			Message:  "request body must be valid JSON",
		},
	})
}

func writeResponseError(w http.ResponseWriter, _ *http.Request, _ error) {
	writeError(w, http.StatusInternalServerError, errorResponse{
		Error:   "internal_server_error",
		Message: "the server could not complete the request",
	})
}

func writeError(w http.ResponseWriter, status int, body errorResponse) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeValidationResponse(w http.ResponseWriter, details []api.ValidationErrorDetail) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusBadRequest)
	_ = json.NewEncoder(w).Encode(api.ValidationErrorResponse{
		Message: "Request validation failed.",
		Error: api.ValidationError{
			Code:    api.ValidationErrorCodeValidationError,
			Details: details,
		},
	})
}

func validationErrorDetails(err error) []api.ValidationErrorDetail {
	details := make([]api.ValidationErrorDetail, 0, 1)
	collectValidationErrorDetails(err, api.Request, "request", &details)
	if len(details) == 0 {
		details = append(details, genericValidationDetail(api.Request, "request"))
	}

	details = normalizeValidationDetails(details)
	const maxValidationDetails = 20
	if len(details) > maxValidationDetails {
		details = details[:maxValidationDetails]
	}
	return details
}

func collectValidationErrorDetails(err error, fallbackLocation api.ValidationErrorDetailLocation, fallbackField string, details *[]api.ValidationErrorDetail) {
	if err == nil {
		return
	}

	switch typed := err.(type) {
	case openapi3.MultiError:
		for _, child := range typed {
			collectValidationErrorDetails(child, fallbackLocation, fallbackField, details)
		}
	case *openapi3filter.RequestError:
		field := fallbackField
		location := fallbackLocation
		switch {
		case typed.Parameter != nil:
			location = api.ValidationErrorDetailLocation(typed.Parameter.In)
			field = typed.Parameter.Name
		case typed.RequestBody != nil:
			location = api.Body
			field = "body"
		}
		if typed.Err != nil {
			collectValidationErrorDetails(typed.Err, location, field, details)
			return
		}
		*details = append(*details, genericValidationDetail(location, field))
	case *openapi3.SchemaError:
		*details = append(*details, schemaValidationDetails(typed, fallbackLocation, fallbackField)...)
	default:
		if children, ok := err.(interface{ Unwrap() []error }); ok {
			for _, child := range children.Unwrap() {
				collectValidationErrorDetails(child, fallbackLocation, fallbackField, details)
			}
			return
		}
		if child := errors.Unwrap(err); child != nil {
			collectValidationErrorDetails(child, fallbackLocation, fallbackField, details)
			return
		}
		*details = append(*details, genericValidationDetail(fallbackLocation, fallbackField))
	}
}

func schemaValidationDetails(schemaErr *openapi3.SchemaError, location api.ValidationErrorDetailLocation, fallbackField string) []api.ValidationErrorDetail {
	if schemaErr.SchemaField == "properties" {
		fields := unknownFields(schemaErr)
		details := make([]api.ValidationErrorDetail, 0, len(fields))
		for _, field := range fields {
			details = append(details, api.ValidationErrorDetail{
				Location: location,
				Field:    field,
				Code:     api.UnknownField,
				Message:  fmt.Sprintf("%s is not allowed", field),
			})
		}
		if len(details) > 0 {
			return details
		}
	}

	field := fallbackField
	if path := schemaErr.JSONPointer(); len(path) > 0 {
		field = formatFieldPath(path)
	}

	return []api.ValidationErrorDetail{{
		Location: location,
		Field:    field,
		Code:     validationCode(schemaErr.SchemaField),
		Message:  validationMessage(field, schemaErr),
	}}
}

func validationCode(schemaField string) api.ValidationErrorDetailCode {
	switch schemaField {
	case "required":
		return api.Required
	case "type":
		return api.InvalidType
	case "minLength":
		return api.MinLength
	case "maxLength":
		return api.MaxLength
	case "properties":
		return api.UnknownField
	default:
		return api.InvalidFormat
	}
}

func validationMessage(field string, schemaErr *openapi3.SchemaError) string {
	if message, ok := customValidationMessage(schemaErr); ok {
		return fmt.Sprintf("%s %s", field, message)
	}

	switch schemaErr.SchemaField {
	case "required":
		return fmt.Sprintf("%s is required", field)
	case "type":
		return fmt.Sprintf("%s has an invalid type", field)
	case "pattern":
		return fmt.Sprintf("%s has an invalid format", field)
	case "format":
		return fmt.Sprintf("%s has an invalid format", field)
	case "minLength":
		return fmt.Sprintf("%s is too short", field)
	case "maxLength":
		return fmt.Sprintf("%s is too long", field)
	default:
		return fmt.Sprintf("%s is invalid", field)
	}
}

func customValidationMessage(schemaErr *openapi3.SchemaError) (string, bool) {
	if schemaErr.Schema == nil {
		return "", false
	}

	extension, ok := schemaErr.Schema.Extensions["x-validation-messages"]
	if !ok {
		return "", false
	}
	messages, ok := extension.(map[string]any)
	if !ok {
		return "", false
	}
	message, ok := messages[schemaErr.SchemaField].(string)
	if !ok || strings.TrimSpace(message) == "" {
		return "", false
	}
	return message, true
}

func genericValidationDetail(location api.ValidationErrorDetailLocation, field string) api.ValidationErrorDetail {
	return api.ValidationErrorDetail{
		Location: location,
		Field:    field,
		Code:     api.InvalidFormat,
		Message:  "request does not match the API contract",
	}
}

func unknownFields(schemaErr *openapi3.SchemaError) []string {
	object, ok := schemaErr.Value.(map[string]any)
	if !ok || schemaErr.Schema == nil {
		return nil
	}
	fields := make([]string, 0)
	for field := range object {
		if _, allowed := schemaErr.Schema.Properties[field]; !allowed {
			fields = append(fields, field)
		}
	}
	sort.Strings(fields)
	return fields
}

func formatFieldPath(path []string) string {
	var field strings.Builder
	for _, part := range path {
		if _, err := strconv.Atoi(part); err == nil {
			fmt.Fprintf(&field, "[%s]", part)
			continue
		}
		if field.Len() > 0 {
			field.WriteByte('.')
		}
		field.WriteString(part)
	}
	return field.String()
}

func normalizeValidationDetails(details []api.ValidationErrorDetail) []api.ValidationErrorDetail {
	type detailKey struct {
		location api.ValidationErrorDetailLocation
		field    string
		code     api.ValidationErrorDetailCode
	}

	unique := make(map[detailKey]api.ValidationErrorDetail, len(details))
	for _, detail := range details {
		unique[detailKey{location: detail.Location, field: detail.Field, code: detail.Code}] = detail
	}

	normalized := make([]api.ValidationErrorDetail, 0, len(unique))
	for _, detail := range unique {
		normalized = append(normalized, detail)
	}
	sort.Slice(normalized, func(i, j int) bool {
		if normalized[i].Field == normalized[j].Field {
			return normalized[i].Code < normalized[j].Code
		}
		return normalized[i].Field < normalized[j].Field
	})
	return normalized
}
