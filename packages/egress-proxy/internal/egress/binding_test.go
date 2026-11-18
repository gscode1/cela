package egress

import (
	"encoding/hex"
	"fmt"
	"net/http"
	"strings"
	"testing"
)

var testBindingKey = func() []byte {
	k := make([]byte, BindingKeyBytes)
	for i := range k {
		k[i] = 7
	}
	return k
}()

func TestBindingOpensWhatNodeSealed(t *testing.T) {
	t.Parallel()
	// Produced by session-core's sealBinding algorithm (packages/session-core/test/egress-bindings.test.ts opens the
	// same bytes): key 32 x 0x07, nonce 00..0b, aad "egress-binding:v1:<session>", plaintext "aoc_vector_token".
	nonce, _ := hex.DecodeString("000102030405060708090a0b")
	ct, _ := hex.DecodeString("79ee8a2f6b6cba3d18c0bae88d33099467108198a6479f972b51a1a0cde5971b")
	got, err := OpenBinding(testBindingKey, sessA, nonce, ct)
	if err != nil || got != "aoc_vector_token" {
		t.Fatalf("OpenBinding = %q, %v", got, err)
	}
	if id := BindingKeyID(testBindingKey); id != "b08d63c5af57a516" {
		t.Errorf("key id %s differs from the TypeScript side", id)
	}
	// Another session's row, another key, or flipped bytes never open.
	if _, err := OpenBinding(testBindingKey, sessB, nonce, ct); err == nil {
		t.Error("a binding opened for another session")
	}
	other := append([]byte(nil), testBindingKey...)
	other[0] ^= 1
	if _, err := OpenBinding(other, sessA, nonce, ct); err == nil {
		t.Error("a binding opened with another key")
	}
	bad := append([]byte(nil), ct...)
	bad[3] ^= 1
	if _, err := OpenBinding(testBindingKey, sessA, nonce, bad); err == nil {
		t.Error("a tampered binding opened")
	}
}

func TestParseBindingKey(t *testing.T) {
	t.Parallel()
	if _, err := ParseBindingKey("c2hvcnQ="); err == nil {
		t.Error("a short key was accepted")
	}
	secret := "not base64 at all 0123456789"
	if _, err := ParseBindingKey(secret); err == nil || strings.Contains(err.Error(), secret) {
		t.Errorf("a bad key must fail without quoting it: %v", err)
	}
	k, err := ParseBindingKey("BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=\n")
	if err != nil || len(k) != 32 {
		t.Errorf("valid key: %v", err)
	}
}

// bindingSnapshot has the sessions of principalSnapshot, A's rule set sending one host through OneCLI, and bindings for
// A (its own token) and B (its own token), both sealed with testBindingKey.
func bindingSnapshot() *Snapshot {
	s := principalSnapshot("127.0.0.1", "127.0.0.1")
	s.Rules = append(s.Rules,
		Rule{ID: "10", SessionID: sessA, Effect: "allow", Host: "gh.example.com", Ports: []int{443}, Route: RouteOneCLI},
		Rule{ID: "11", SessionID: sessB, Effect: "allow", Host: "gh.example.com", Ports: []int{443}, Route: RouteOneCLI},
		Rule{ID: "12", SessionID: sessA, Effect: "allow", Host: "nobinding.example.com", Ports: []int{443}, Route: RouteOneCLI},
	)
	return s
}

func addBinding(s *Snapshot, key []byte, session, token string, rows *[]bindingRow) {
	nonce := make([]byte, 12)
	copy(nonce, session)
	*rows = append(*rows, bindingRow{
		SessionID: session, KeyID: BindingKeyID(key), Nonce: hex.EncodeToString(nonce),
		Ciphertext: hex.EncodeToString(sealBinding(key, session, token, nonce)),
	})
	s.addBindings(*rows)
}

var chainDNS = map[string][]string{
	"gh.example.com": {"93.184.216.34"}, "nobinding.example.com": {"93.184.216.34"}, "all.example.com": {"93.184.216.34"}, "a-only.example.com": {"93.184.216.34"},
}

func chainEnv(t *testing.T, snap *Snapshot, key []byte) (*rulesEnv, *fakeUpstream) {
	t.Helper()
	origin := newFakeOrigin(t)
	up := newFakeUpstream(t, origin.ln.Addr().String())
	e := newRulesEnv(t, rulesEnvOpts{snap: snap, dns: chainDNS, principals: true, upstream: up.ln.Addr().String(), bindingKey: key})
	e.origin = origin
	return e, up
}

func TestOneCLIRouteChainsWithTheSessionsOwnTokenOnly(t *testing.T) {
	t.Parallel()
	snap := bindingSnapshot()
	var rows []bindingRow
	addBinding(snap, testBindingKey, sessA, "aoc_token_of_a", &rows)
	addBinding(snap, testBindingKey, sessB, "aoc_token_of_b", &rows)
	e, up := chainEnv(t, snap, testBindingKey)

	// The client tries to pick the next hop and to forward its own Proxy-Authorization.
	c, br, status, _ := connect(t, e.proxyAddr, "gh.example.com:443", basic(pTokA),
		"X-Upstream-Https-Proxy: http://evil.invalid:3128", "Proxy-Authorization: "+basic("client-chosen"))
	if status != http.StatusOK {
		t.Fatalf("status %d, want 200", status)
	}
	if got := get(t, c, br, "/repo"); got != http.StatusOK {
		t.Errorf("origin answered %d", got)
	}
	seen, conns := up.seen()
	if conns != 1 || seen["gh.example.com:443"] != basic("aoc_token_of_a") {
		t.Fatalf("upstream saw %d connects, auth %q, want session A's OneCLI token", conns, seen["gh.example.com:443"])
	}
	// B reaches the same host with B's own token: A's binding is not B's.
	c2, br2, status2, _ := connect(t, e.proxyAddr, "gh.example.com:443", basic(pTokB))
	if status2 != http.StatusOK {
		t.Fatalf("B status %d", status2)
	}
	get(t, c2, br2, "/other")
	if seen, _ := up.seen(); seen["gh.example.com:443"] != basic("aoc_token_of_b") {
		t.Errorf("B's tunnel carried %q", seen["gh.example.com:443"])
	}
	// The origin never sees either token, any proxy header or the chosen next hop.
	dump := strings.ToLower(e.origin.dump())
	for _, secret := range []string{pTokA, pTokB, "aoc_token_of_a", "aoc_token_of_b", "client-chosen", "proxy-authorization", "x-upstream", "evil.invalid"} {
		if strings.Contains(dump, strings.ToLower(secret)) {
			t.Errorf("origin saw %q", secret)
		}
	}
	if d := e.dialed(); len(d) != 0 {
		t.Errorf("the onecli route dialled %v directly", d)
	}
}

func TestOneCLIRouteWithoutABindingIsDeniedNeverDirect(t *testing.T) {
	t.Parallel()
	snap := bindingSnapshot()
	var rows []bindingRow
	addBinding(snap, testBindingKey, sessB, "aoc_token_of_b", &rows) // A has none
	e, up := chainEnv(t, snap, testBindingKey)
	for _, host := range []string{"gh.example.com", "nobinding.example.com"} {
		if got := statusOf(t, e, host+":443", basic(pTokA)); got != 407 {
			t.Errorf("%s: status %d, want a deny", host, got)
		}
	}
	if _, conns := up.seen(); conns != 0 {
		t.Errorf("OneCLI was dialled %d times for a session with no binding", conns)
	}
	if d := e.dialed(); len(d) != 0 {
		t.Errorf("fell back to a direct dial: %v", d)
	}
}

func TestOneCLIRouteDeniedWhenTheBindingDoesNotOpen(t *testing.T) {
	t.Parallel()
	other := append([]byte(nil), testBindingKey...)
	other[5] ^= 0xff
	for name, build := range map[string]func(*Snapshot){
		"sealed with another key": func(s *Snapshot) {
			var rows []bindingRow
			addBinding(s, other, sessA, "aoc_token_of_a", &rows)
		},
		"copied from another session's row": func(s *Snapshot) {
			var rows []bindingRow
			addBinding(s, testBindingKey, sessB, "aoc_token_of_b", &rows)
			rows[0].SessionID = sessA // B's ciphertext under A's id
			s.addBindings(rows)
		},
	} {
		snap := bindingSnapshot()
		build(snap)
		e, up := chainEnv(t, snap, testBindingKey)
		if got := statusOf(t, e, "gh.example.com:443", basic(pTokA)); got != 407 {
			t.Errorf("%s: status %d, want a deny", name, got)
		}
		if _, conns := up.seen(); conns != 0 {
			t.Errorf("%s: OneCLI was dialled", name)
		}
	}
	// A proxy without a key has no bindings at all.
	snap := bindingSnapshot()
	var rows []bindingRow
	addBinding(snap, testBindingKey, sessA, "aoc_token_of_a", &rows)
	e, up := chainEnv(t, snap, nil)
	if got := statusOf(t, e, "gh.example.com:443", basic(pTokA)); got != 407 {
		t.Errorf("no key: status %d", got)
	}
	if _, conns := up.seen(); conns != 0 {
		t.Error("no key: OneCLI was dialled")
	}
}

func TestOneCLIIsNeverDialledForDirectDecisions(t *testing.T) {
	t.Parallel()
	snap := bindingSnapshot()
	var rows []bindingRow
	addBinding(snap, testBindingKey, sessA, "aoc_token_of_a", &rows)
	e, up := chainEnv(t, snap, testBindingKey)
	for _, target := range []string{"all.example.com:443", "a-only.example.com:443"} {
		c, br, status, _ := connect(t, e.proxyAddr, target, basic(pTokA))
		if status != http.StatusOK {
			t.Fatalf("%s: status %d", target, status)
		}
		get(t, c, br, "/")
	}
	if _, conns := up.seen(); conns != 0 {
		t.Errorf("OneCLI was dialled %d times for direct routes", conns)
	}
	if len(e.dialed()) == 0 {
		t.Error("the direct route did not dial the origin")
	}
}

func TestBindingRowsAreParsedFromTheLoadStatement(t *testing.T) {
	t.Parallel()
	nonce := hex.EncodeToString(make([]byte, 12))
	rows := fmt.Sprintf(`[{"session_id":%q,"key_id":"b08d63c5af57a516","nonce":%q,"ciphertext":"aabb"},{"session_id":"","key_id":"x","nonce":"zz","ciphertext":"aa"}]`, sessA, nonce)
	s, err := parseSnapshot(1, []byte(`[]`), []byte(`[]`), nil, []byte(rows))
	if err != nil {
		t.Fatal(err)
	}
	if s.Bindings() != 1 || s.InvalidBindings != 1 {
		t.Fatalf("bindings %d invalid %d, want 1 and 1", s.Bindings(), s.InvalidBindings)
	}
	if _, ok := (SnapshotPrincipals{Source: sourceFunc(func() (*Snapshot, bool) { return s, true }), BindingKey: testBindingKey}).OneCLIToken(sessA); ok {
		t.Error("garbage ciphertext opened")
	}
}
