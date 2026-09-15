package statement

import "errors"

var (
	// ErrInvalidCursor is returned when an opaque pagination cursor is malformed
	// or contains invalid position data.
	ErrInvalidCursor = errors.New("invalid pagination cursor")
)
