package statement

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math"
	"strings"
	"time"
)

// Position identifies one movement in the stable statement order.
type Position struct {
	RecordedAt       time.Time
	JournalReference string
	LineNumber       int
}

// Cursor identifies where and in which direction statement pagination resumes.
type Cursor struct {
	Navigation Navigation
	Position   Position
}

type cursorPayload struct {
	Navigation       Navigation `json:"nav"`
	RecordedAt       time.Time  `json:"rec"`
	JournalReference string     `json:"jref"`
	LineNumber       int        `json:"ln"`
	From             time.Time  `json:"from"`
	To               time.Time  `json:"to"`
}

func validPosition(pos Position) bool {
	if pos.RecordedAt.IsZero() {
		return false
	}
	if pos.JournalReference == "" || len(pos.JournalReference) > 64 || strings.IndexByte(pos.JournalReference, 0) >= 0 {
		return false
	}
	if pos.LineNumber <= 0 || pos.LineNumber > math.MaxInt16 {
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
		Navigation:       cursor.Navigation,
		RecordedAt:       cursor.Position.RecordedAt.UTC(),
		JournalReference: cursor.Position.JournalReference,
		LineNumber:       cursor.Position.LineNumber,
		From:             period.From.UTC(),
		To:               period.To.UTC(),
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
		RecordedAt:       payload.RecordedAt,
		JournalReference: payload.JournalReference,
		LineNumber:       payload.LineNumber,
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
