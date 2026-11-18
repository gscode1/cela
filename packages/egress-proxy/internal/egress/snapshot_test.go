package egress

import (
	"testing"
	"time"
)

func TestParseSnapshotSkipsInvalidRows(t *testing.T) {
	t.Parallel()
	sets := `[{"name":"open-web","applies_to_all":true,"revision":3},{"name":"npm","applies_to_all":false}]`
	rules := `[
	 {"id":1,"rule_set":"open-web","session_id":null,"effect":"allow","host":"*","ports":[443],"route":"direct","allows_private":false,"expires_at":null},
	 {"id":2,"rule_set":"npm","session_id":null,"effect":"allow","host":"registry.npmjs.org","ports":[443],"route":"onecli","allows_private":false,"expires_at":"2026-12-01T10:00:00.123456+00:00"},
	 {"id":3,"rule_set":null,"session_id":"AAAAAAAA-1111-4111-8111-111111111111","effect":"deny","host":".bad.example","ports":[80,443],"route":"direct","allows_private":false,"expires_at":null},
	 {"id":4,"rule_set":"npm","session_id":null,"effect":"allow","host":"10.0.0.0/8","ports":[443],"route":"direct","allows_private":false,"expires_at":null},
	 {"id":5,"rule_set":"npm","session_id":null,"effect":"maybe","host":"a.example.com","ports":[443],"route":"direct","allows_private":false,"expires_at":null},
	 {"id":6,"rule_set":"npm","session_id":null,"effect":"allow","host":"*","ports":[443],"route":"onecli","allows_private":false,"expires_at":null},
	 {"id":7,"rule_set":"npm","session_id":null,"effect":"allow","host":"db.internal.example","ports":[5432],"route":"direct","allows_private":true,"expires_at":null},
	 {"id":8,"rule_set":"npm","session_id":null,"effect":"allow","host":"10.20.0.0/16","ports":[5432],"route":"direct","allows_private":true,"expires_at":null},
	 {"id":9,"rule_set":"npm","session_id":null,"effect":"allow","host":"a.example.com","ports":[],"route":"direct","allows_private":false,"expires_at":null}
	]`
	s, err := parseSnapshot(12, []byte(sets), []byte(rules))
	if err != nil {
		t.Fatal(err)
	}
	if s.Revision != 12 || len(s.RuleSets) != 2 || !s.RuleSets[0].AppliesToAll {
		t.Fatalf("snapshot %+v", s)
	}
	var ids []string
	for _, r := range s.Rules {
		ids = append(ids, r.ID)
	}
	want := []string{"1", "2", "3", "7", "8"}
	if len(ids) != len(want) {
		t.Fatalf("kept rules %v, want %v (invalid %d)", ids, want, s.Invalid)
	}
	for i := range want {
		if ids[i] != want[i] {
			t.Fatalf("kept rules %v, want %v", ids, want)
		}
	}
	if s.Invalid != 4 {
		t.Errorf("invalid %d, want 4", s.Invalid)
	}
	if s.Rules[1].ExpiresAt == nil || !s.Rules[1].ExpiresAt.Equal(time.Date(2026, 12, 1, 10, 0, 0, 123456000, time.UTC)) {
		t.Errorf("expiry %v", s.Rules[1].ExpiresAt)
	}
	if s.Rules[2].SessionID != "aaaaaaaa-1111-4111-8111-111111111111" {
		t.Errorf("session id %q is not lowercased", s.Rules[2].SessionID)
	}
}

func TestParseSnapshotRejectsBrokenJSON(t *testing.T) {
	t.Parallel()
	if _, err := parseSnapshot(1, []byte(`{`), []byte(`[]`)); err == nil {
		t.Error("broken rule sets accepted")
	}
	if _, err := parseSnapshot(1, []byte(`[]`), []byte(`nope`)); err == nil {
		t.Error("broken rules accepted")
	}
}
