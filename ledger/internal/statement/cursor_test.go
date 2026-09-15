package statement_test

import (
	"encoding/base64"
	"errors"
	"strings"
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
			RecordedAt:       recordedAt,
			JournalReference: "jrn_01M20J1QD2XB8K7G4N9CVF6T3A",
			LineNumber:       2,
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
	if decodedCursor.Position.JournalReference != "jrn_01M20J1QD2XB8K7G4N9CVF6T3A" {
		t.Errorf("decoded JournalReference = %q, want jrn_01M20J1QD2XB8K7G4N9CVF6T3A", decodedCursor.Position.JournalReference)
	}
	if decodedCursor.Position.LineNumber != 2 {
		t.Errorf("decoded LineNumber = %d, want %d", decodedCursor.Position.LineNumber, 2)
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

	t.Run("invalid position data", func(t *testing.T) {
		token := base64.RawURLEncoding.EncodeToString([]byte(`{"nav":"next","rec":"0001-01-01T00:00:00Z","jref":"","ln":0,"from":"2026-09-01T00:00:00Z","to":"2026-10-01T00:00:00Z"}`))
		_, _, err := statement.DecodeCursor(token)
		if !errors.Is(err, statement.ErrInvalidCursor) {
			t.Errorf("DecodeCursor() error = %v, want ErrInvalidCursor", err)
		}
	})

	t.Run("line number exceeds max int16", func(t *testing.T) {
		token := base64.RawURLEncoding.EncodeToString([]byte(`{"nav":"next","rec":"2026-09-10T09:15:00Z","jref":"jrn_01M20J1QD2XB8K7G4N9CVF6T3A","ln":40000,"from":"2026-09-01T00:00:00Z","to":"2026-10-01T00:00:00Z"}`))
		_, _, err := statement.DecodeCursor(token)
		if !errors.Is(err, statement.ErrInvalidCursor) {
			t.Errorf("DecodeCursor() error = %v, want ErrInvalidCursor", err)
		}
	})

	t.Run("negative line number", func(t *testing.T) {
		token := base64.RawURLEncoding.EncodeToString([]byte(`{"nav":"next","rec":"2026-09-10T09:15:00Z","jref":"jrn_01M20J1QD2XB8K7G4N9CVF6T3A","ln":-1,"from":"2026-09-01T00:00:00Z","to":"2026-10-01T00:00:00Z"}`))
		_, _, err := statement.DecodeCursor(token)
		if !errors.Is(err, statement.ErrInvalidCursor) {
			t.Errorf("DecodeCursor() error = %v, want ErrInvalidCursor", err)
		}
	})

	t.Run("overlong journal reference", func(t *testing.T) {
		longRef := strings.Repeat("a", 65)
		token := base64.RawURLEncoding.EncodeToString([]byte(`{"nav":"next","rec":"2026-09-10T09:15:00Z","jref":"` + longRef + `","ln":1,"from":"2026-09-01T00:00:00Z","to":"2026-10-01T00:00:00Z"}`))
		_, _, err := statement.DecodeCursor(token)
		if !errors.Is(err, statement.ErrInvalidCursor) {
			t.Errorf("DecodeCursor() error = %v, want ErrInvalidCursor", err)
		}
	})

	t.Run("journal reference containing null byte", func(t *testing.T) {
		token := base64.RawURLEncoding.EncodeToString([]byte(`{"nav":"next","rec":"2026-09-10T09:15:00Z","jref":"jrn_\u0000test","ln":1,"from":"2026-09-01T00:00:00Z","to":"2026-10-01T00:00:00Z"}`))
		_, _, err := statement.DecodeCursor(token)
		if !errors.Is(err, statement.ErrInvalidCursor) {
			t.Errorf("DecodeCursor() error = %v, want ErrInvalidCursor", err)
		}
	})

	t.Run("invalid direction", func(t *testing.T) {
		token := base64.RawURLEncoding.EncodeToString([]byte(`{"nav":"diagonal","rec":"2026-09-10T09:15:00Z","jref":"jrn_123","ln":1,"from":"2026-09-01T00:00:00Z","to":"2026-10-01T00:00:00Z"}`))
		_, _, err := statement.DecodeCursor(token)
		if !errors.Is(err, statement.ErrInvalidCursor) {
			t.Errorf("DecodeCursor() error = %v, want ErrInvalidCursor", err)
		}
	})

	t.Run("invalid period", func(t *testing.T) {
		token := base64.RawURLEncoding.EncodeToString([]byte(`{"nav":"next","rec":"2026-09-10T09:15:00Z","jref":"jrn_123","ln":1,"from":"2026-10-01T00:00:00Z","to":"2026-09-01T00:00:00Z"}`))
		_, _, err := statement.DecodeCursor(token)
		if !errors.Is(err, statement.ErrInvalidCursor) {
			t.Errorf("DecodeCursor() error = %v, want ErrInvalidCursor", err)
		}
	})
}
