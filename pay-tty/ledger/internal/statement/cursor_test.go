package statement_test

import (
	"encoding/base64"
	"errors"
	"testing"
	"time"

	"yanmifeakeju.com/ledger/internal/statement"
)

func TestCursor_RoundTrip(t *testing.T) {
	recordedAt := time.Date(2026, time.September, 10, 9, 15, 0, 0, time.UTC)
	from := time.Date(2026, time.September, 1, 0, 0, 0, 0, time.UTC)
	to := time.Date(2026, time.October, 1, 0, 0, 0, 0, time.UTC)

	cursor := &statement.Cursor{
		Navigation: statement.NavigationNext,
		Position: statement.Position{
			RecordedAt: recordedAt,
			Sequence:   2,
		},
	}
	period := statement.Period{From: from, To: to}

	token, err := statement.EncodeCursor(cursor, period)
	if err != nil {
		t.Fatalf("EncodeCursor() error = %v", err)
	}
	if token == nil || *token == "" {
		t.Fatal("EncodeCursor() returned nil or empty token")
	}

	decodedCursor, decodedPeriod, err := statement.DecodeCursor(*token)
	if err != nil {
		t.Fatalf("DecodeCursor() error = %v", err)
	}

	if decodedCursor.Navigation != cursor.Navigation {
		t.Errorf("decoded Navigation = %q, want %q", decodedCursor.Navigation, cursor.Navigation)
	}
	if !decodedCursor.Position.RecordedAt.Equal(recordedAt) {
		t.Errorf("decoded RecordedAt = %v, want %v", decodedCursor.Position.RecordedAt, recordedAt)
	}
	if decodedCursor.Position.Sequence != 2 {
		t.Errorf("decoded Sequence = %d, want %d", decodedCursor.Position.Sequence, 2)
	}
	if !decodedPeriod.From.Equal(from) {
		t.Errorf("decoded Period.From = %v, want %v", decodedPeriod.From, from)
	}
	if !decodedPeriod.To.Equal(to) {
		t.Errorf("decoded Period.To = %v, want %v", decodedPeriod.To, to)
	}
}

func TestCursor_NilCursor(t *testing.T) {
	period := statement.Period{
		From: time.Now().Add(-24 * time.Hour),
		To:   time.Now(),
	}

	token, err := statement.EncodeCursor(nil, period)
	if err != nil {
		t.Fatalf("EncodeCursor(nil) error = %v", err)
	}
	if token != nil {
		t.Errorf("EncodeCursor(nil) token = %v, want nil", token)
	}
}

func TestCursor_InvalidTokens(t *testing.T) {
	t.Run("malformed base64", func(t *testing.T) {
		_, _, err := statement.DecodeCursor("not-valid-base64!@#$")
		if !errors.Is(err, statement.ErrInvalidCursor) {
			t.Errorf("DecodeCursor() error = %v, want ErrInvalidCursor", err)
		}
	})

	t.Run("malformed json in base64", func(t *testing.T) {
		token := base64.RawURLEncoding.EncodeToString([]byte("not json"))
		_, _, err := statement.DecodeCursor(token)
		if !errors.Is(err, statement.ErrInvalidCursor) {
			t.Errorf("DecodeCursor() error = %v, want ErrInvalidCursor", err)
		}
	})

	t.Run("invalid position data - zero time", func(t *testing.T) {
		token := base64.RawURLEncoding.EncodeToString([]byte(`{"nav":"next","rec":"0001-01-01T00:00:00Z","seq":1,"from":"2026-09-01T00:00:00Z","to":"2026-10-01T00:00:00Z"}`))
		_, _, err := statement.DecodeCursor(token)
		if !errors.Is(err, statement.ErrInvalidCursor) {
			t.Errorf("DecodeCursor() error = %v, want ErrInvalidCursor", err)
		}
	})

	t.Run("invalid position data - zero sequence", func(t *testing.T) {
		token := base64.RawURLEncoding.EncodeToString([]byte(`{"nav":"next","rec":"2026-09-10T09:15:00Z","seq":0,"from":"2026-09-01T00:00:00Z","to":"2026-10-01T00:00:00Z"}`))
		_, _, err := statement.DecodeCursor(token)
		if !errors.Is(err, statement.ErrInvalidCursor) {
			t.Errorf("DecodeCursor() error = %v, want ErrInvalidCursor", err)
		}
	})

	t.Run("negative sequence", func(t *testing.T) {
		token := base64.RawURLEncoding.EncodeToString([]byte(`{"nav":"next","rec":"2026-09-10T09:15:00Z","seq":-1,"from":"2026-09-01T00:00:00Z","to":"2026-10-01T00:00:00Z"}`))
		_, _, err := statement.DecodeCursor(token)
		if !errors.Is(err, statement.ErrInvalidCursor) {
			t.Errorf("DecodeCursor() error = %v, want ErrInvalidCursor", err)
		}
	})

	t.Run("invalid direction", func(t *testing.T) {
		token := base64.RawURLEncoding.EncodeToString([]byte(`{"nav":"diagonal","rec":"2026-09-10T09:15:00Z","seq":1,"from":"2026-09-01T00:00:00Z","to":"2026-10-01T00:00:00Z"}`))
		_, _, err := statement.DecodeCursor(token)
		if !errors.Is(err, statement.ErrInvalidCursor) {
			t.Errorf("DecodeCursor() error = %v, want ErrInvalidCursor", err)
		}
	})

	t.Run("invalid period", func(t *testing.T) {
		token := base64.RawURLEncoding.EncodeToString([]byte(`{"nav":"next","rec":"2026-09-10T09:15:00Z","seq":1,"from":"2026-10-01T00:00:00Z","to":"2026-09-01T00:00:00Z"}`))
		_, _, err := statement.DecodeCursor(token)
		if !errors.Is(err, statement.ErrInvalidCursor) {
			t.Errorf("DecodeCursor() error = %v, want ErrInvalidCursor", err)
		}
	})
}
