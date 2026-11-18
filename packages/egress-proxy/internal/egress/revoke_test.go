package egress

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// Revocation of open tunnels (ADR 0039): the proxy is wired as in production (Loader, Rules, SnapshotPrincipals,
// Subscribe), a test publishes a new snapshot the way a read does, and watches live tunnels.

type revokeEnv struct {
	*rulesEnv
	live   atomic.Pointer[Snapshot]
	loader *Loader
	clock  *stepClock
	logs   *lockedBuffer
	hook   atomic.Pointer[func()]
}

func newRevokeEnv(t *testing.T, snap *Snapshot, dns map[string][]string, upstream string, key []byte) *revokeEnv {
	t.Helper()
	e := &revokeEnv{clock: &stepClock{t: time.Unix(1000, 0)}, logs: &lockedBuffer{}}
	e.live.Store(snap)
	e.loader = &Loader{
		Fetch:      func(context.Context) (*Snapshot, error) { return e.live.Load(), nil },
		Now:        e.clock.now,
		StaleAfter: 2 * time.Minute,
	}
	if err := e.loader.Refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	e.rulesEnv = newRulesEnv(t, rulesEnvOpts{
		source: e.loader, dns: dns, principals: true, upstream: upstream, bindingKey: key, logs: e.logs,
		onDial: func() {
			if h := e.hook.Load(); h != nil {
				(*h)()
			}
		},
	})
	e.loader.Subscribe(func() { e.p.Sweep() }, func() { e.p.CloseAll("stale") })
	return e
}

// publish makes s the snapshot the next read returns and reads it, which sweeps the open tunnels.
func (e *revokeEnv) publish(t *testing.T, s *Snapshot) {
	t.Helper()
	e.live.Store(s)
	if err := e.loader.Refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
}

// next is a copy of the current snapshot at the next revision; edit it before publishing.
func (e *revokeEnv) next() *Snapshot {
	cp := *e.live.Load()
	cp.Revision++
	return &cp
}

func (e *revokeEnv) stream(t *testing.T, target, token string) *bufio.Reader {
	t.Helper()
	c, br, status, _ := connect(t, e.proxyAddr, target, basic(token))
	if status != http.StatusOK {
		t.Fatalf("%s: status %d, want 200", target, status)
	}
	_ = c.SetDeadline(time.Now().Add(30 * time.Second))
	if _, err := fmt.Fprintf(c, "GET /stream HTTP/1.1\r\nHost: origin.example\r\n\r\n"); err != nil {
		t.Fatal(err)
	}
	if err := readTick(br); err != nil {
		t.Fatalf("%s: no data: %v", target, err)
	}
	return br
}

func mustEnd(t *testing.T, name string, br *bufio.Reader) {
	t.Helper()
	if d, ok := endsWithin(br, 2*time.Second); !ok {
		t.Errorf("%s: still open after %v", name, d)
	}
}

func mustStream(t *testing.T, name string, br *bufio.Reader) {
	t.Helper()
	for i := 0; i < 3; i++ {
		if err := readTick(br); err != nil {
			t.Fatalf("%s: tunnel was closed: %v", name, err)
		}
	}
}

func without(rules []Rule, ids ...string) []Rule {
	var out []Rule
next:
	for _, r := range rules {
		for _, id := range ids {
			if r.ID == id {
				continue next
			}
		}
		out = append(out, r)
	}
	return out
}

func TestSweepClosesDeniedTunnelAndKeepsAllowed(t *testing.T) {
	t.Parallel()
	e := newRevokeEnv(t, principalSnapshot("127.0.0.1", "127.0.0.1"), principalDNS, "", nil)
	viaSet := e.stream(t, "all.example.com:443", pTokA)
	viaSession := e.stream(t, "a-session.example.com:443", pTokA)
	other := e.stream(t, "all.example.com:443", pTokB)

	// Rule 4 is A's own; rule 1 (the set that applies to all) stays.
	s := e.next()
	s.Rules = without(s.Rules, "4")
	e.publish(t, s)

	mustEnd(t, "session rule tunnel", viaSession)
	mustStream(t, "set rule tunnel", viaSet)
	mustStream(t, "other session", other)
	if n := e.p.Registry.Open(sessA); n != 1 {
		t.Errorf("session A has %d tracked tunnels, want 1", n)
	}
	log := e.logs.String()
	if !strings.Contains(log, "tunnel-revoked") || !strings.Contains(log, "reason=rule-denied") ||
		!strings.Contains(log, "host=a-session.example.com") || !strings.Contains(log, "port=443") || !strings.Contains(log, "session="+sessA) {
		t.Errorf("no tunnel-revoked event with session, host, port and reason:\n%s", log)
	}
	if strings.Contains(log, pTokA) || strings.Contains(log, pTokB) {
		t.Error("the log holds an egress token")
	}
	if e.p.Registry.Revoked() != 1 {
		t.Errorf("revoked count %d, want 1", e.p.Registry.Revoked())
	}

	// Removing the set's rule closes both remaining tunnels to that host, for every session.
	s = e.next()
	s.Rules = without(s.Rules, "1")
	e.publish(t, s)
	mustEnd(t, "set rule tunnel A", viaSet)
	mustEnd(t, "set rule tunnel B", other)
}

func TestSweepKeepsEverythingWhenNothingChanged(t *testing.T) {
	t.Parallel()
	e := newRevokeEnv(t, principalSnapshot("127.0.0.1", "127.0.0.1"), principalDNS, "", nil)
	br := e.stream(t, "all.example.com:443", pTokA)
	e.publish(t, e.next())
	mustStream(t, "tunnel", br)
	if e.p.Registry.Revoked() != 0 {
		t.Errorf("revoked %d tunnels of an unchanged snapshot", e.p.Registry.Revoked())
	}
}

func TestPrincipalRevokeClosesAllOfThatSessionsTunnels(t *testing.T) {
	t.Parallel()
	e := newRevokeEnv(t, principalSnapshot("127.0.0.1", "127.0.0.1"), principalDNS, "", nil)
	a1 := e.stream(t, "all.example.com:443", pTokA)
	a2 := e.stream(t, "a-session.example.com:443", pTokA)
	a3 := e.stream(t, "a-only.example.com:443", pTokA)
	b := e.stream(t, "all.example.com:443", pTokB)

	s := e.next()
	rest := &Snapshot{}
	*rest = *s
	rest.addPrincipals([]principalRow{{SessionID: sessB, TokenHash: HashToken(pTokB), RuleSets: []string{"prof-b"}, PodIP: strPtr("127.0.0.1")}})
	e.publish(t, rest)

	for name, br := range map[string]*bufio.Reader{"a1": a1, "a2": a2, "a3": a3} {
		mustEnd(t, name, br)
	}
	mustStream(t, "session B", b)
	if !strings.Contains(e.logs.String(), "reason=principal-revoked") {
		t.Error("no principal-revoked event")
	}
	// The revoked session cannot open a new one either (the token is unknown now).
	if got := statusOf(t, e.rulesEnv, "all.example.com:443", basic(pTokA)); got != 407 {
		t.Errorf("revoked principal got %d, want 407", got)
	}
}

func strPtr(s string) *string { return &s }

func bindingEnv(t *testing.T) (*revokeEnv, *Snapshot) {
	t.Helper()
	origin := newFakeOrigin(t)
	up := newFakeUpstream(t, origin.ln.Addr().String())
	snap := bindingSnapshot()
	var rows []bindingRow
	addBinding(snap, testBindingKey, sessA, "aoc_token_of_a", &rows)
	addBinding(snap, testBindingKey, sessB, "aoc_token_of_b", &rows)
	return newRevokeEnv(t, snap, chainDNS, up.ln.Addr().String(), testBindingKey), snap
}

func TestBindingChangeClosesOneCLITunnelsOnly(t *testing.T) {
	t.Parallel()
	e, _ := bindingEnv(t)
	oneA := e.stream(t, "gh.example.com:443", pTokA)
	oneB := e.stream(t, "gh.example.com:443", pTokB)
	direct := e.stream(t, "all.example.com:443", pTokA)

	// Same bindings, new revision: nothing closes (no spurious closes on an unrelated change).
	e.publish(t, e.next())
	mustStream(t, "A onecli unchanged", oneA)

	// A's token rotates: its onecli tunnel closes so the next connection carries the new one; B's and A's direct stay.
	s := e.next()
	var rows []bindingRow
	addBinding(s, testBindingKey, sessA, "aoc_rotated_token_a", &rows)
	addBinding(s, testBindingKey, sessB, "aoc_token_of_b", &rows)
	e.publish(t, s)
	mustEnd(t, "A onecli after rotation", oneA)
	mustStream(t, "B onecli", oneB)
	mustStream(t, "A direct", direct)
	if !strings.Contains(e.logs.String(), "reason=binding-changed") {
		t.Error("no binding-changed event")
	}
	if strings.Contains(e.logs.String(), "aoc_") {
		t.Error("the log holds a OneCLI token")
	}

	// B's binding is deleted: its onecli tunnel closes.
	s = e.next()
	rows = nil
	addBinding(s, testBindingKey, sessA, "aoc_rotated_token_a", &rows)
	e.publish(t, s)
	mustEnd(t, "B onecli after delete", oneB)
	if !strings.Contains(e.logs.String(), "reason=binding-removed") {
		t.Error("no binding-removed event")
	}
}

func TestRouteChangeClosesTheTunnel(t *testing.T) {
	t.Parallel()
	e, _ := bindingEnv(t)
	br := e.stream(t, "gh.example.com:443", pTokA)
	s := e.next()
	s.Rules = append([]Rule(nil), s.Rules...)
	for i := range s.Rules {
		if s.Rules[i].ID == "10" {
			s.Rules[i].Route = RouteDirect
		}
	}
	e.publish(t, s)
	mustEnd(t, "onecli tunnel after the route became direct", br)
	if !strings.Contains(e.logs.String(), "reason=route-changed") {
		t.Error("no route-changed event")
	}
}

func TestStaleSnapshotClosesEveryOpenTunnel(t *testing.T) {
	t.Parallel()
	e := newRevokeEnv(t, principalSnapshot("127.0.0.1", "127.0.0.1"), principalDNS, "", nil)
	a := e.stream(t, "all.example.com:443", pTokA)
	b := e.stream(t, "all.example.com:443", pTokB)

	e.clock.advance(time.Minute)
	e.loader.checkStale()
	mustStream(t, "A before the limit", a)
	e.clock.advance(61 * time.Second)
	e.loader.checkStale()
	mustEnd(t, "A", a)
	mustEnd(t, "B", b)
	if !strings.Contains(e.logs.String(), "reason=stale") {
		t.Error("no stale event")
	}
	if got := statusOf(t, e.rulesEnv, "all.example.com:443", basic(pTokA)); got == 200 {
		t.Error("a stale proxy opened a tunnel")
	}
	// A successful read brings it back, and the next stale episode closes again.
	e.publish(t, e.next())
	c := e.stream(t, "all.example.com:443", pTokA)
	e.clock.advance(3 * time.Minute)
	e.loader.checkStale()
	mustEnd(t, "tunnel of the second episode", c)
}

// A snapshot that denies the tunnel arrives after the decision and before the tunnel is tracked: the sweep it
// triggers finds nothing to close, so the tunnel must be refused by the check after Track.
func TestSnapshotBetweenDecisionAndTrackRefusesTheTunnel(t *testing.T) {
	t.Parallel()
	e := newRevokeEnv(t, principalSnapshot("127.0.0.1", "127.0.0.1"), principalDNS, "", nil)
	var once sync.Once
	h := func() {
		once.Do(func() {
			s := e.next()
			s.Rules = without(s.Rules, "4")
			e.live.Store(s)
			if err := e.loader.Refresh(context.Background()); err != nil {
				t.Error(err)
			}
		})
	}
	e.hook.Store(&h)
	_, _, status, _ := connect(t, e.proxyAddr, "a-session.example.com:443", basic(pTokA))
	if status == http.StatusOK {
		t.Fatal("a tunnel the new snapshot denies was established")
	}
	if n := e.p.Registry.Total(); n != 0 {
		t.Errorf("%d tunnels tracked", n)
	}
	if !strings.Contains(e.logs.String(), "reason=rule-denied") {
		t.Error("no tunnel-revoked event for the refused tunnel")
	}
}

// Tunnels open while snapshots flip between allowing and denying. After the last denying snapshot has been read, no
// tunnel may be left, whichever side of the decision, the track and the sweep each one fell on.
func TestNoTunnelSurvivesASnapshotThatDeniesIt(t *testing.T) {
	t.Parallel()
	e := newRevokeEnv(t, principalSnapshot("127.0.0.1", "127.0.0.1"), principalDNS, "", nil)
	allow := e.live.Load()
	deny := *allow
	deny.Rules = without(allow.Rules, "4")

	for round := 0; round < 15; round++ {
		allow2 := *allow
		allow2.Revision = int64(100 + 2*round)
		deny2 := deny
		deny2.Revision = int64(101 + 2*round)
		e.publish(t, &allow2)

		var wg sync.WaitGroup
		results := make(chan *bufio.Reader, 16)
		for i := 0; i < 12; i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				time.Sleep(time.Duration(i) * 300 * time.Microsecond)
				br, c := rawStream(e.proxyAddr, "a-session.example.com:443", pTokA)
				if br != nil {
					results <- br
					t.Cleanup(func() { _ = c.Close() })
				}
			}(i)
		}
		time.Sleep(time.Duration(round%4) * time.Millisecond)
		e.live.Store(&deny2)
		if err := e.loader.Refresh(context.Background()); err != nil {
			t.Fatal(err)
		}
		wg.Wait()
		close(results)
		for br := range results {
			if d, ok := endsWithin(br, 3*time.Second); !ok {
				t.Fatalf("round %d: a tunnel survived the denying snapshot (waited %v)", round, d)
			}
		}
		deadline := time.Now().Add(2 * time.Second)
		for e.p.Registry.Total() != 0 && time.Now().Before(deadline) {
			time.Sleep(5 * time.Millisecond)
		}
		if n := e.p.Registry.Total(); n != 0 {
			t.Fatalf("round %d: %d tunnels still tracked", round, n)
		}
	}
}

// rawStream opens a tunnel and starts the endless stream, without t (it runs on test goroutines). It returns nil when
// the proxy refused.
func rawStream(addr, target, token string) (*bufio.Reader, net.Conn) {
	c, err := net.DialTimeout("tcp", addr, ioWait)
	if err != nil {
		return nil, nil
	}
	_ = c.SetDeadline(time.Now().Add(30 * time.Second))
	if _, err := fmt.Fprintf(c, "CONNECT %s HTTP/1.1\r\nHost: %s\r\nProxy-Authorization: %s\r\n\r\n", target, target, basic(token)); err != nil {
		_ = c.Close()
		return nil, nil
	}
	br := bufio.NewReader(c)
	resp, err := http.ReadResponse(br, &http.Request{Method: http.MethodConnect})
	if err != nil || resp.StatusCode != http.StatusOK {
		_ = c.Close()
		return nil, nil
	}
	if _, err := io.WriteString(c, "GET /stream HTTP/1.1\r\nHost: origin.example\r\n\r\n"); err != nil {
		_ = c.Close()
		return nil, nil
	}
	return br, c
}
