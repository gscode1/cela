package egress

import (
	"bytes"
	"net/http"
	"net/netip"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

const (
	sessA = "aaaaaaaa-1111-4111-8111-111111111111"
	sessB = "bbbbbbbb-2222-4222-8222-222222222222"
	// Not real tokens: fixed test strings whose hashes the snapshot holds.
	pTokA = "principal-test-token-a-0123456789abcdef"
	pTokB = "principal-test-token-b-0123456789abcdef"
)

// principalSnapshot has two sessions bound to loopback (where the tests connect from) and one bound elsewhere. Session A
// profile names rule set "prof-a", B names "prof-b".
func principalSnapshot(podA, podB string) *Snapshot {
	s := baseSnapshot(
		allowRule("1", "all", "all.example.com"),
		allowRule("2", "prof-a", "a-only.example.com"),
		allowRule("3", "prof-b", "b-only.example.com"),
		Rule{ID: "4", SessionID: sessA, Effect: "allow", Host: "a-session.example.com", Ports: []int{443}, Route: RouteDirect},
	)
	s.RuleSets = append(s.RuleSets, RuleSet{Name: "prof-a"}, RuleSet{Name: "prof-b"})
	row := func(session, token string, sets []string, ip string) principalRow {
		r := principalRow{SessionID: session, TokenHash: HashToken(token), RuleSets: sets}
		if ip != "" {
			r.PodIP = &ip
		}
		return r
	}
	s.addPrincipals([]principalRow{row(sessA, pTokA, []string{"prof-a"}, podA), row(sessB, pTokB, []string{"prof-b"}, podB)})
	return s
}

var principalDNS = map[string][]string{
	"all.example.com": {"93.184.216.34"}, "a-only.example.com": {"93.184.216.34"},
	"b-only.example.com": {"93.184.216.34"}, "a-session.example.com": {"93.184.216.34"},
}

// lockedBuffer is a log sink that tunnel goroutines write while the test reads it.
type lockedBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *lockedBuffer) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

func statusOf(t *testing.T, e *rulesEnv, target, auth string) int {
	t.Helper()
	_, _, status, _ := connect(t, e.proxyAddr, target, auth)
	return status
}

func TestPrincipalAppliesItsProfileSetsAndSessionRules(t *testing.T) {
	t.Parallel()
	e := newRulesEnv(t, rulesEnvOpts{snap: principalSnapshot("127.0.0.1", "127.0.0.1"), dns: principalDNS, principals: true})
	for _, c := range []struct {
		target, auth string
		want         int
	}{
		{"all.example.com:443", basic(pTokA), http.StatusOK},       // applies to all
		{"a-only.example.com:443", basic(pTokA), http.StatusOK},    // A's profile set
		{"a-session.example.com:443", basic(pTokA), http.StatusOK}, // A's own session rule
		{"b-only.example.com:443", basic(pTokA), 407},              // B's profile set is not A's
		{"a-session.example.com:443", basic(pTokB), 407},           // A's session rule is not B's
		{"b-only.example.com:443", basic(pTokB), http.StatusOK},    // B's profile set
		{"a-only.example.com:443", "", 407},                        // anonymous: only applies_to_all
		{"all.example.com:443", "", http.StatusOK},                 // anonymous: applies_to_all
	} {
		if got := statusOf(t, e, c.target, c.auth); got != c.want {
			t.Errorf("%s (authenticated: %v): status %d, want %d", c.target, c.auth != "", got, c.want)
		}
	}
}

func TestUnknownAndRevokedTokensAreRefusedNotServedAnonymously(t *testing.T) {
	t.Parallel()
	var live atomic.Pointer[Snapshot]
	live.Store(principalSnapshot("127.0.0.1", "127.0.0.1"))
	e := newRulesEnv(t, rulesEnvOpts{live: &live, dns: principalDNS, principals: true})
	// An unknown token would reach all.example.com anonymously; it must not.
	if got := statusOf(t, e, "all.example.com:443", basic("a-token-nobody-has")); got != 407 {
		t.Errorf("unknown token: status %d, want 407", got)
	}
	if got := statusOf(t, e, "all.example.com:443", "Basic !!!"); got != 407 {
		t.Errorf("malformed credentials: status %d, want 407", got)
	}
	if got := statusOf(t, e, "all.example.com:443", "Bearer "+pTokA); got != 407 {
		t.Errorf("a Bearer header: status %d, want 407", got)
	}
	// Revoking removes the row from the snapshot (the loader reads only live principals): the next snapshot has B only.
	next := principalSnapshot("127.0.0.1", "127.0.0.1")
	delete(next.byHash, HashToken(pTokA))
	delete(next.bySession, sessA)
	live.Store(next)
	if got := statusOf(t, e, "all.example.com:443", basic(pTokA)); got != 407 {
		t.Errorf("revoked token: status %d, want 407", got)
	}
	if got := statusOf(t, e, "all.example.com:443", basic(pTokB)); got != http.StatusOK {
		t.Errorf("B's token after A's revocation: status %d, want 200", got)
	}
}

func TestTokenIsBoundToThePodAddress(t *testing.T) {
	t.Parallel()
	// A is bound to the real client address (loopback), B's token to another Pod: used from here it is "B's token from
	// A's pod" and fails. A principal with no recorded address is refused as well.
	snap := principalSnapshot("127.0.0.1", "10.244.9.9")
	e := newRulesEnv(t, rulesEnvOpts{snap: snap, dns: principalDNS, principals: true})
	if got := statusOf(t, e, "all.example.com:443", basic(pTokA)); got != http.StatusOK {
		t.Errorf("A from its own address: status %d, want 200", got)
	}
	if got := statusOf(t, e, "all.example.com:443", basic(pTokB)); got != 407 {
		t.Errorf("B's token from another address: status %d, want 407", got)
	}
	unknown := principalSnapshot("", "127.0.0.1")
	e2 := newRulesEnv(t, rulesEnvOpts{snap: unknown, dns: principalDNS, principals: true})
	if got := statusOf(t, e2, "all.example.com:443", basic(pTokA)); got != 407 {
		t.Errorf("a principal with no recorded address: status %d, want 407", got)
	}
	if got := statusOf(t, e2, "all.example.com:443", basic(pTokB)); got != http.StatusOK {
		t.Errorf("a principal with a recorded address: status %d, want 200", got)
	}
}

func TestRequireAuthRefusesAnonymousRequests(t *testing.T) {
	t.Parallel()
	e := newRulesEnv(t, rulesEnvOpts{snap: principalSnapshot("127.0.0.1", "127.0.0.1"), dns: principalDNS, principals: true, requireAuth: true})
	if got := statusOf(t, e, "all.example.com:443", ""); got != 407 {
		t.Errorf("anonymous with RequireAuth: status %d, want 407", got)
	}
	if got := statusOf(t, e, "all.example.com:443", basic(pTokA)); got != http.StatusOK {
		t.Errorf("authenticated with RequireAuth: status %d, want 200", got)
	}
}

func TestNoSnapshotMeansNoPrincipals(t *testing.T) {
	t.Parallel()
	if _, ok := (SnapshotPrincipals{Source: sourceFunc(func() (*Snapshot, bool) { return nil, false })}).Lookup(pTokA); ok {
		t.Error("a token was accepted without a usable snapshot")
	}
}

func TestTokenNeverAppearsInProxyLogs(t *testing.T) {
	t.Parallel()
	var logs lockedBuffer
	e := newRulesEnv(t, rulesEnvOpts{snap: principalSnapshot("127.0.0.1", "10.244.9.9"), dns: principalDNS, principals: true, logs: &logs})
	for _, auth := range []string{basic(pTokA), basic(pTokB), basic("unknown-token-xyz")} {
		for _, host := range []string{"all.example.com:443", "b-only.example.com:443"} {
			statusOf(t, e, host, auth)
		}
	}
	out := logs.String()
	for _, secret := range []string{pTokA, pTokB, "unknown-token-xyz", HashToken(pTokA)} {
		if strings.Contains(out, secret) {
			t.Errorf("a token or its hash appears in the proxy log")
		}
	}
	// The base64 form of the credentials, which is what a copied header would carry.
	for _, auth := range []string{basic(pTokA), basic(pTokB)} {
		if strings.Contains(out, strings.TrimPrefix(auth, "Basic ")) {
			t.Errorf("the Proxy-Authorization value appears in the proxy log")
		}
	}
}

func TestSnapshotPrincipalsParse(t *testing.T) {
	t.Parallel()
	hash := HashToken(pTokA)
	rows := `[{"session_id":"` + strings.ToUpper(sessA) + `","token_hash":"` + hash + `","rule_sets":["npm"],"pod_ip":"10.244.1.7"},
	 {"session_id":"` + sessB + `","token_hash":"` + HashToken(pTokB) + `","rule_sets":[],"pod_ip":null},
	 {"session_id":"","token_hash":"` + hash + `","rule_sets":[]},
	 {"session_id":"cccccccc-3333-4333-8333-333333333333","token_hash":"short","rule_sets":[]}]`
	s, err := parseSnapshot(1, []byte(`[]`), []byte(`[]`), []byte(rows), nil)
	if err != nil {
		t.Fatal(err)
	}
	if s.Principals() != 2 || s.InvalidPrincipals != 2 {
		t.Fatalf("principals %d invalid %d, want 2 and 2", s.Principals(), s.InvalidPrincipals)
	}
	p, ok := SnapshotPrincipals{Source: sourceFunc(func() (*Snapshot, bool) { return s, true })}.Lookup(pTokA)
	if !ok || p.Session != sessA || p.PodIP != netip.MustParseAddr("10.244.1.7") || len(p.RuleSets) != 1 {
		t.Errorf("lookup: %+v ok=%v", p, ok)
	}
	if b, _ := s.bySession[sessB]; b.PodIP.IsValid() {
		t.Errorf("a principal with no address got %v", b.PodIP)
	}
}
