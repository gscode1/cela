package egress

import (
	"bufio"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestConcurrentSessionsNeverSwapUpstreamTokens(t *testing.T) {
	t.Parallel()
	e := newEnv(t, envOpts{})
	const n = 50
	want := map[string]string{} // CONNECT target -> expected Proxy-Authorization
	var mu sync.Mutex
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		sess, tok, oc := "a", tokA, ocA
		if i%2 == 1 {
			sess, tok, oc = "b", tokB, ocB
		}
		target := fmt.Sprintf("%s-%d.example:443", sess, i)
		mu.Lock()
		want[target] = basic(oc)
		mu.Unlock()
		wg.Add(1)
		go func() {
			defer wg.Done()
			c, br, status, _ := connect(t, e.proxyAddr, target, basic(tok))
			if status != 200 {
				t.Errorf("%s: status %d", target, status)
				return
			}
			if code := get(t, c, br, "/x"); code != 200 {
				t.Errorf("%s: origin status %d", target, code)
			}
		}()
	}
	wg.Wait()

	got, conns := e.up.seen()
	if conns != n || len(got) != n {
		t.Fatalf("upstream saw %d connects, %d targets, want %d", conns, len(got), n)
	}
	for target, w := range want {
		if got[target] != w {
			t.Errorf("%s: upstream got Proxy-Authorization %q, want session's own", target, got[target])
		}
	}
	dump := e.origin.dump()
	for _, secret := range []string{tokA, tokB, ocA, ocB, basic(tokA), basic(ocA), basic(tokB), basic(ocB)} {
		if strings.Contains(dump, secret) {
			t.Errorf("origin saw a token: %q", secret)
		}
	}
	if e.origin.count() != n {
		t.Errorf("origin saw %d requests, want %d", e.origin.count(), n)
	}
	if strings.Contains(strings.ToLower(dump), "proxy-authorization") || strings.Contains(strings.ToLower(dump), "x-upstream") {
		t.Error("origin saw a proxy header")
	}
}

func TestClientUpstreamHeaderIsIgnored(t *testing.T) {
	t.Parallel()
	evil, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = evil.Close() })
	var mu sync.Mutex
	hits := 0
	go func() {
		for {
			c, err := evil.Accept()
			if err != nil {
				return
			}
			mu.Lock()
			hits++
			mu.Unlock()
			_ = c.Close()
		}
	}()
	e := newEnv(t, envOpts{})
	hdr := "X-Upstream-Https-Proxy: http://attacker:pw@" + evil.Addr().String()

	c, br, status, _ := connect(t, e.proxyAddr, "git.example:443", basic(tokA), hdr, "x-upstream-https-proxy: http://"+evil.Addr().String())
	if status != 200 {
		t.Fatalf("status %d", status)
	}
	get(t, c, br, "/x")
	seen, conns := e.up.seen()
	if conns != 1 || seen["git.example:443"] != basic(ocA) {
		t.Errorf("real upstream not used with the session token: %v", seen)
	}
	mu.Lock()
	defer mu.Unlock()
	if hits != 0 {
		t.Errorf("client-chosen proxy was contacted %d times", hits)
	}
	if strings.Contains(e.origin.dump(), "attacker") {
		t.Error("origin saw the client's proxy header")
	}
}

func TestClientUpstreamHeaderIgnoredOnDirectRoute(t *testing.T) {
	t.Parallel()
	evil, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = evil.Close() })
	hits := make(chan struct{}, 4)
	go func() {
		for {
			c, err := evil.Accept()
			if err != nil {
				return
			}
			hits <- struct{}{}
			_ = c.Close()
		}
	}()
	e := newEnv(t, envOpts{
		dns:   fakeResolver{"direct.example": "127.0.0.1"},
		tweak: allowLoopback,
		rules: func(origin, _ string) map[string][]HostRule {
			return map[string][]HostRule{"a": {{Host: "direct.example", Ports: []int{portOf(origin)}, Route: RouteDirect}}}
		},
	})
	target := fmt.Sprintf("direct.example:%d", portOf(e.origin.ln.Addr().String()))
	c, br, status, _ := connect(t, e.proxyAddr, target, basic(tokA), "X-Upstream-Https-Proxy: http://"+evil.Addr().String())
	if status != 200 {
		t.Fatalf("direct route status %d", status)
	}
	if code := get(t, c, br, "/x"); code != 200 {
		t.Fatalf("origin status %d", code)
	}
	if _, conns := e.up.seen(); conns != 0 {
		t.Errorf("direct route used the upstream %d times", conns)
	}
	select {
	case <-hits:
		t.Error("client-chosen proxy was contacted")
	case <-time.After(200 * time.Millisecond):
	}
	if strings.Contains(e.origin.dump(), tokA) {
		t.Error("origin saw the egress token")
	}
}

func TestRejectedRequests(t *testing.T) {
	t.Parallel()
	e := newEnv(t, envOpts{
		rules: func(_, up string) map[string][]HostRule {
			return map[string][]HostRule{
				"a":      {{Host: "*.example", Route: RouteOneCLI}, {Host: "only-a.test", Route: RouteOneCLI}, {Host: "127.0.0.1", Ports: []int{portOf(up)}, Route: RouteDirect}},
				"b":      {{Host: "*.example", Route: RouteOneCLI}},
				"nobind": {{Host: "*.example", Route: RouteOneCLI}},
			}
		},
		dns: fakeResolver{"only-a.test": "203.0.113.11"},
	})
	up := e.up.ln.Addr().String()
	cases := []struct {
		name, target, auth string
	}{
		{"no token", "git.example:443", ""},
		{"garbage auth", "git.example:443", "Basic !!!"},
		{"bearer", "git.example:443", "Bearer " + tokA},
		{"unknown token", "git.example:443", basic("nope")},
		{"egress token as username", "git.example:443", "Basic " + "eDo="},
		{"host not allowed", "not-allowed.test:443", basic(tokA)},
		{"port not allowed", "git.example:8443", basic(tokA)},
		{"other session's host", "only-a.test:443", basic(tokB)},
		{"upstream address as destination", up, basic(tokA)},
		{"onecli route without binding", "git.example:443", basic("egress-token-nobind-0003")},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c, _, status, h := connect(t, e.proxyAddr, tc.target, tc.auth)
			_ = c
			if status != http.StatusProxyAuthRequired {
				t.Errorf("status %d, want 407", status)
			}
			if h.Get("Proxy-Authenticate") == "" {
				t.Error("407 without Proxy-Authenticate")
			}
		})
	}
	if _, conns := e.up.seen(); conns != 0 {
		t.Errorf("a rejected request reached the upstream (%d connects)", conns)
	}

	t.Run("plain HTTP proxy request", func(t *testing.T) {
		c, err := net.Dial("tcp", e.proxyAddr)
		if err != nil {
			t.Fatal(err)
		}
		defer c.Close()
		_ = c.SetDeadline(time.Now().Add(ioWait))
		fmt.Fprintf(c, "GET http://git.example/ HTTP/1.1\r\nHost: git.example\r\nProxy-Authorization: %s\r\n\r\n", basic(tokA))
		resp, err := http.ReadResponse(bufio.NewReader(c), nil)
		if err != nil {
			t.Fatal(err)
		}
		if resp.StatusCode != http.StatusMethodNotAllowed {
			t.Errorf("status %d, want 405", resp.StatusCode)
		}
	})
	if e.origin.count() != 0 {
		t.Error("origin was reached")
	}
}

func TestDirectRouteDeniesInternalAddresses(t *testing.T) {
	t.Parallel()
	e := newEnv(t, envOpts{
		dns: fakeResolver{
			"priv.example":   "10.0.0.5",
			"meta.example":   "169.254.169.254",
			"loop.example":   "127.0.0.1",
			"mapped.example": "::ffff:10.0.0.5",
			"cgnat.example":  "100.64.0.9",
			"nat64.example":  "64:ff9b::a00:5",
			"ula.example":    "fd00::5",
		},
		rules: func(_, up string) map[string][]HostRule {
			return map[string][]HostRule{"a": {
				{Host: "*.example", Route: RouteDirect},
				{Host: "169.254.169.254", Route: RouteDirect},
				{Host: "10.1.2.3", Route: RouteDirect},
				{Host: "127.0.0.1", Ports: []int{portOf(up)}, Route: RouteDirect},
			}}
		},
	})
	up := e.up.ln.Addr().String()
	for _, target := range []string{
		"priv.example:443", "meta.example:443", "loop.example:443", "mapped.example:443",
		"cgnat.example:443", "nat64.example:443", "ula.example:443",
		"169.254.169.254:443", "10.1.2.3:443", up,
	} {
		t.Run(target, func(t *testing.T) {
			_, _, status, _ := connect(t, e.proxyAddr, target, basic(tokA))
			if status != http.StatusProxyAuthRequired {
				t.Errorf("status %d, want 407 (denied)", status)
			}
		})
	}
	if _, conns := e.up.seen(); conns != 0 {
		t.Errorf("upstream was dialled %d times", conns)
	}
}

// The upstream is on loopback, which Smokescreen refuses to dial; the onecli
// route works anyway (TestConcurrent...), and the exemption must not leak.
func TestUpstreamExemptionDoesNotLeakToDirectRoute(t *testing.T) {
	t.Parallel()
	e := newEnv(t, envOpts{
		dns: fakeResolver{"up.example": "127.0.0.1"},
		rules: func(_, up string) map[string][]HostRule {
			return map[string][]HostRule{"a": {{Host: "up.example", Ports: []int{portOf(up)}, Route: RouteDirect}}}
		},
	})
	target := fmt.Sprintf("up.example:%d", portOf(e.up.ln.Addr().String()))
	_, _, status, _ := connect(t, e.proxyAddr, target, basic(tokA))
	if status == http.StatusOK {
		t.Fatal("direct route reached the upstream's private address")
	}
	if _, conns := e.up.seen(); conns != 0 {
		t.Errorf("upstream dialled %d times", conns)
	}
}

func openStream(t *testing.T, e *env, target, token string) (net.Conn, *bufio.Reader) {
	t.Helper()
	c, br, status, _ := connect(t, e.proxyAddr, target, basic(token))
	if status != 200 {
		t.Fatalf("status %d", status)
	}
	_ = c.SetDeadline(time.Now().Add(30 * time.Second))
	if _, err := fmt.Fprintf(c, "GET /stream HTTP/1.1\r\nHost: origin.example\r\n\r\n"); err != nil {
		t.Fatal(err)
	}
	return c, br
}

func readTick(br *bufio.Reader) error {
	for {
		line, err := br.ReadString('\n')
		if err != nil {
			return err
		}
		if line == "tick\n" {
			return nil
		}
	}
}

// endsWithin reports whether the stream stops delivering ticks within d.
func endsWithin(br *bufio.Reader, d time.Duration) (time.Duration, bool) {
	start := time.Now()
	res := make(chan struct{})
	go func() {
		for readTick(br) == nil {
		}
		close(res)
	}()
	select {
	case <-res:
		return time.Since(start), true
	case <-time.After(d):
		return d, false
	}
}

func TestCloseSessionEndsItsTunnelsOnly(t *testing.T) {
	t.Parallel()
	e := newEnv(t, envOpts{})
	_, brA1 := openStream(t, e, "a1.example:443", tokA)
	_, brA2 := openStream(t, e, "a2.example:443", tokA)
	cB, brB := openStream(t, e, "b1.example:443", tokB)
	for _, br := range []*bufio.Reader{brA1, brA2, brB} {
		if err := readTick(br); err != nil {
			t.Fatal(err)
		}
	}
	if e.p.Registry.Open("a") != 2 || e.p.Registry.Open("b") != 1 {
		t.Fatalf("registry: a=%d b=%d", e.p.Registry.Open("a"), e.p.Registry.Open("b"))
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/admin/sessions/a/close-tunnels", nil)
	req.Header.Set("Authorization", "Bearer admin-secret")
	e.admin.ServeHTTP(rec, req)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"closed":2`) {
		t.Fatalf("admin: %d %s", rec.Code, rec.Body.String())
	}
	for i, br := range []*bufio.Reader{brA1, brA2} {
		if d, ok := endsWithin(br, time.Second); !ok {
			t.Errorf("session a stream %d still open after 1s", i)
		} else {
			t.Logf("stream %d ended after %v", i, d)
		}
	}
	// B keeps streaming.
	_ = cB.SetDeadline(time.Now().Add(ioWait))
	for i := 0; i < 5; i++ {
		if err := readTick(brB); err != nil {
			t.Fatalf("session b stream broke: %v", err)
		}
	}
	if e.p.Registry.Open("b") != 1 {
		t.Error("session b tunnel was removed")
	}
	deadline := time.Now().Add(time.Second)
	for e.p.Registry.Open("a") != 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if n := e.p.Registry.Open("a"); n != 0 {
		t.Errorf("session a still has %d tracked tunnels", n)
	}
}

func TestAdminNeedsToken(t *testing.T) {
	t.Parallel()
	reg := NewRegistry(0)
	h := AdminHandler(reg, "admin-secret")
	for _, auth := range []string{"", "Bearer wrong", "admin-secret"} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "/admin/sessions/a/close-tunnels", nil)
		if auth != "" {
			req.Header.Set("Authorization", auth)
		}
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("auth %q: status %d", auth, rec.Code)
		}
	}
}

func TestMaxTunnelAge(t *testing.T) {
	t.Parallel()
	e := newEnv(t, envOpts{maxAge: 400 * time.Millisecond})
	_, br := openStream(t, e, "a1.example:443", tokA)
	if err := readTick(br); err != nil {
		t.Fatal(err)
	}
	if d, ok := endsWithin(br, 2*time.Second); !ok {
		t.Fatal("tunnel outlived its maximum age")
	} else if d > 1500*time.Millisecond {
		t.Errorf("ended after %v", d)
	}
}

// An upstream that accepts TCP but never answers CONNECT must fail the client
// within the handshake timeout, not hold the tunnel until max age.
func TestUpstreamHandshakeTimeout(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			t.Cleanup(func() { _ = c.Close() })
		}
	}()
	e := newEnv(t, envOpts{handshake: 300 * time.Millisecond, upstream: ln.Addr().String()})
	start := time.Now()
	c, _, code, _ := connect(t, e.proxyAddr, "svc.example:443", basic(tokA))
	_ = c.Close()
	if code == http.StatusOK {
		t.Fatalf("status = %d, want an error", code)
	}
	if d := time.Since(start); d > 3*time.Second {
		t.Fatalf("took %v, want about the 300ms handshake timeout", d)
	}
}

// The handshake deadline must be cleared once the tunnel is established.
func TestUpstreamHandshakeDeadlineClearedAfterTunnel(t *testing.T) {
	e := newEnv(t, envOpts{handshake: 300 * time.Millisecond})
	c, br, code, _ := connect(t, e.proxyAddr, "svc.example:443", basic(tokA))
	if code != http.StatusOK {
		t.Fatalf("status = %d", code)
	}
	time.Sleep(700 * time.Millisecond)
	if got := get(t, c, br, "/"); got != http.StatusOK {
		t.Fatalf("GET after the handshake window = %d", got)
	}
}
