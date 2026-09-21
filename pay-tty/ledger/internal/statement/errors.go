package statement

import "errors"

// ErrInvalidCursor is returned when an opaque pagination cursor is malformed
// or contains invalid position data.
var ErrInvalidCursor = errors.New("invalid pagination cursor")

// ErrPeriodNotOrdered is returned when the resolved period's From is not
// before its To.
var ErrPeriodNotOrdered = errors.New("statement period from must be before to")

// ErrPeriodTooLong is returned when the resolved period exceeds [MaxPeriod].
var ErrPeriodTooLong = errors.New("statement period exceeds maximum")
