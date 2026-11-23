package egress

import (
	"bufio"
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stripe/smokescreen/v2/pkg/smokescreen"
)

const (
	tokA   = "egress-token-session-a-0001"
	tokB   = "egress-token-session-b-0002"
	ocA    = "aoc_onecli_token_for_session_a"
	ocB    = "aoc_onecli_token_for_session_b"
	ioWait = 5 * time.Second
)

func TestMain(m *testing.M) {
	// CONNECT routing must not depend on the machine running the tests.
	for _, key := range []string{"HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"} {
		if value, ok := os.LookupEnv(key); ok {
			if err := os.Unsetenv(key); err != nil {
				panic(err)
			}
			defer func() {
				if err := os.Setenv(key, value); err != nil {
					panic(err)
				}
			}()
		}
	}
	m.Run()
}

// fakeUpstream stands in for OneCLI: it records the Proxy-Authorization of
// every CONNECT, then tunnels to the fake origin whatever the target is.
type fakeUpstream struct {
	ln     net.Listener
	origin string
	mu     sync.Mutex
	auth   map[string]string // CONNECT target -> Proxy-Authorization
	conns  int
}

func newFakeUpstream(t *testing.T, origin string) *fakeUpstream {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	u := &fakeUpstream{ln: ln, origin: origin, auth: map[string]string{}}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go u.handle(c)
		}
	}()
	return u
}

func (u *fakeUpstream) handle(c net.Conn) {
	defer c.Close()
	br := bufio.NewReader(c)
	req, err := http.ReadRequest(br)
	if err != nil || req.Method != http.MethodConnect {
		return
	}
	u.mu.Lock()
	u.conns++
	u.auth[req.Host] = req.Header.Get("Proxy-Authorization")
	u.mu.Unlock()
	o, err := net.Dial("tcp", u.origin)
	if err != nil {
		_, _ = io.WriteString(c, "HTTP/1.1 502 Bad Gateway\r\n\r\n")
		return
	}
	defer o.Close()
	_, _ = io.WriteString(c, "HTTP/1.1 200 Connection established\r\n\r\n")
	done := make(chan struct{}, 2)
	go func() { _, _ = io.Copy(o, br); done <- struct{}{} }()
	go func() { _, _ = io.Copy(c, o); done <- struct{}{} }()
	<-done
}

func (u *fakeUpstream) seen() (map[string]string, int) {
	u.mu.Lock()
	defer u.mu.Unlock()
	m := make(map[string]string, len(u.auth))
	for k, v := range u.auth {
		m[k] = v
	}
	return m, u.conns
}

// fakeOrigin records every request it gets (all headers) and serves /stream
// as an endless line stream.
type fakeOrigin struct {
	ln   net.Listener
	mu   sync.Mutex
	reqs []string
}

func newFakeOrigin(t *testing.T) *fakeOrigin {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	o := &fakeOrigin{ln: ln}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go o.handle(c)
		}
	}()
	return o
}

func (o *fakeOrigin) handle(c net.Conn) {
	defer c.Close()
	br := bufio.NewReader(c)
	for {
		req, err := http.ReadRequest(br)
		if err != nil {
			return
		}
		var sb strings.Builder
		fmt.Fprintf(&sb, "%s %s\n", req.Method, req.RequestURI)
		for k, v := range req.Header {
			fmt.Fprintf(&sb, "%s: %s\n", k, strings.Join(v, ","))
		}
		fmt.Fprintf(&sb, "Host: %s\n", req.Host)
		o.mu.Lock()
		o.reqs = append(o.reqs, sb.String())
		o.mu.Unlock()
		if req.URL.Path == "/stream" {
			_, _ = io.WriteString(c, "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n")
			for {
				if _, err := io.WriteString(c, "tick\n"); err != nil {
					return
				}
				time.Sleep(20 * time.Millisecond)
			}
		}
		_, _ = io.WriteString(c, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
	}
}

func (o *fakeOrigin) dump() string {
	o.mu.Lock()
	defer o.mu.Unlock()
	return strings.Join(o.reqs, "\n--\n")
}

func (o *fakeOrigin) count() int {
	o.mu.Lock()
	defer o.mu.Unlock()
	return len(o.reqs)
}

// fakeResolver maps names to IPs; any *.example name not listed is a public address.
type fakeResolver map[string]string

func (r fakeResolver) LookupPort(_ context.Context, _, service string) (int, error) {
	var p int
	if _, err := fmt.Sscanf(service, "%d", &p); err != nil {
		return 0, err
	}
	return p, nil
}

func (r fakeResolver) LookupIP(_ context.Context, _, host string) ([]net.IP, error) {
	if ip := net.ParseIP(host); ip != nil {
		return []net.IP{ip}, nil
	}
	if s, ok := r[host]; ok {
		return []net.IP{net.ParseIP(s)}, nil
	}
	if strings.HasSuffix(host, ".example") {
		return []net.IP{net.ParseIP("203.0.113.10")}, nil
	}
	return nil, fmt.Errorf("no such host %s", host)
}

type env struct {
	proxyAddr string
	p         *Proxy
	up        *fakeUpstream
	origin    *fakeOrigin
}

type envOpts struct {
	maxAge time.Duration
	rules  func(origin, upstream string) map[string][]HostRule // addresses host:port
	dns    fakeResolver
	tweak  func(*smokescreen.Config)
	// upstream replaces the fake OneCLI address; handshake the CONNECT timeout.
	upstream  string
	handshake time.Duration
}

func newEnv(t *testing.T, o envOpts) *env {
	t.Helper()
	origin := newFakeOrigin(t)
	up := newFakeUpstream(t, origin.ln.Addr().String())
	rules := map[string][]HostRule{
		"a": {{Host: "*.example", Route: RouteOneCLI}},
		"b": {{Host: "*.example", Route: RouteOneCLI}},
	}
	if o.rules != nil {
		rules = o.rules(origin.ln.Addr().String(), up.ln.Addr().String())
	}
	st, err := NewStatic(StaticConfig{
		Principals: []StaticPrincipal{
			{Session: "a", EgressToken: tokA, OneCLIToken: ocA},
			{Session: "b", EgressToken: tokB, OneCLIToken: ocB},
			{Session: "nobind", EgressToken: "egress-token-nobind-0003"},
		},
		Rules: rules,
	})
	if err != nil {
		t.Fatal(err)
	}
	dns := o.dns
	upAddr := up.ln.Addr().String()
	if o.upstream != "" {
		upAddr = o.upstream
	}
	p, err := Build(Options{
		Principals:               st,
		RequireAuth:              true,
		Authorizer:               st,
		UpstreamAddr:             upAddr,
		UpstreamHandshakeTimeout: o.handshake,
		MaxTunnelAge:             o.maxAge,
		Log:                      slog.New(slog.NewTextHandler(io.Discard, nil)),
		Tweak: func(c *smokescreen.Config) {
			c.Resolver = dns
			if o.tweak != nil {
				o.tweak(c)
			}
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(p.Handler())
	t.Cleanup(srv.Close)
	return &env{
		proxyAddr: strings.TrimPrefix(srv.URL, "http://"),
		p:         p, up: up, origin: origin,
	}
}

func basic(token string) string {
	return "Basic " + base64.StdEncoding.EncodeToString([]byte("x:"+token))
}

// connect sends a CONNECT through the proxy. header lines are raw "K: V".
func connect(t *testing.T, proxyAddr, target, auth string, extra ...string) (net.Conn, *bufio.Reader, int, http.Header) {
	t.Helper()
	c, err := net.DialTimeout("tcp", proxyAddr, ioWait)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close() })
	_ = c.SetDeadline(time.Now().Add(ioWait))
	var sb strings.Builder
	fmt.Fprintf(&sb, "CONNECT %s HTTP/1.1\r\nHost: %s\r\n", target, target)
	if auth != "" {
		fmt.Fprintf(&sb, "Proxy-Authorization: %s\r\n", auth)
	}
	for _, e := range extra {
		sb.WriteString(e + "\r\n")
	}
	sb.WriteString("\r\n")
	if _, err := io.WriteString(c, sb.String()); err != nil {
		t.Fatal(err)
	}
	br := bufio.NewReader(c)
	resp, err := http.ReadResponse(br, &http.Request{Method: http.MethodConnect})
	if err != nil {
		t.Fatalf("read CONNECT response for %s: %v", target, err)
	}
	return c, br, resp.StatusCode, resp.Header
}

// get sends a GET through an open tunnel and returns the status line's code.
func get(t *testing.T, c net.Conn, br *bufio.Reader, path string) int {
	t.Helper()
	_ = c.SetDeadline(time.Now().Add(ioWait))
	if _, err := fmt.Fprintf(c, "GET %s HTTP/1.1\r\nHost: origin.example\r\nUser-Agent: test\r\n\r\n", path); err != nil {
		t.Fatal(err)
	}
	resp, err := http.ReadResponse(br, nil)
	if err != nil {
		t.Fatalf("read origin response: %v", err)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	return resp.StatusCode
}

// allowLoopback lets a test reach the fake origin on 127.0.0.1 over the direct route.
func allowLoopback(c *smokescreen.Config) {
	_, n, _ := net.ParseCIDR("127.0.0.1/32")
	c.AllowRanges = append(c.AllowRanges, smokescreen.RuleRange{Net: *n})
	c.AllowSelfConnections = true
}

func portOf(addr string) int {
	_, p, _ := net.SplitHostPort(addr)
	var n int
	_, _ = fmt.Sscanf(p, "%d", &n)
	return n
}
