package statement

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"time"
)

// Position identifies one movement in the stable statement order.
type Position struct {
	RecordedAt time.Time
	Sequence   int64
}

// Cursor identifies where and in which direction statement pagination resumes.
type Cursor struct {
	Navigation Navigation
	Position   Position
}

type cursorPayload struct {
	Navigation Navigation `json:"nav"`
	RecordedAt time.Time  `json:"rec"`
	Sequence   int64      `json:"seq"`
	From       time.Time  `json:"from"`
	To         time.Time  `json:"to"`
}

func validPosition(pos Position) bool {
	if pos.RecordedAt.IsZero() {
		return false
	}
	if pos.Sequence <= 0 {
		return false
	}
	return true
}

func validNavigation(nav Navigation) bool {
	return nav == NavigationNext || nav == NavigationPrevious
}

func validPeriod(period Period) bool {
	return !period.From.IsZero() && !period.To.IsZero() && period.From.Before(period.To)
}

// EncodeCursor serializes a cursor, binding its position and statement period.
// Returns nil string if cursor is nil.
func EncodeCursor(cursor *Cursor, period Period) (*string, error) {
	if cursor == nil {
		return nil, nil
	}
	if !validPosition(cursor.Position) {
		return nil, fmt.Errorf("%w: invalid position values", ErrInvalidCursor)
	}
	if !validNavigation(cursor.Navigation) {
		return nil, fmt.Errorf("%w: unknown navigation direction %q", ErrInvalidCursor, cursor.Navigation)
	}

	payload := cursorPayload{
		Navigation: cursor.Navigation,
		RecordedAt: cursor.Position.RecordedAt.UTC(),
		Sequence:   cursor.Position.Sequence,
		From:       period.From.UTC(),
		To:         period.To.UTC(),
	}

	data, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("marshal cursor payload: %w", err)
	}

	token := base64.RawURLEncoding.EncodeToString(data)
	return &token, nil
}

// DecodeCursor parses an opaque cursor token and extracts the cursor and period.
func DecodeCursor(token string) (*Cursor, Period, error) {
	data, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil {
		return nil, Period{}, ErrInvalidCursor
	}

	var payload cursorPayload
	if err := json.Unmarshal(data, &payload); err != nil {
		return nil, Period{}, ErrInvalidCursor
	}

	pos := Position{
		RecordedAt: payload.RecordedAt,
		Sequence:   payload.Sequence,
	}
	period := Period{
		From: payload.From,
		To:   payload.To,
	}

	if !validNavigation(payload.Navigation) || !validPosition(pos) || !validPeriod(period) {
		return nil, Period{}, ErrInvalidCursor
	}

	cursor := &Cursor{
		Navigation: payload.Navigation,
		Position:   pos,
	}

	return cursor, period, nil
}
