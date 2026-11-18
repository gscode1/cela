package egress

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"time"

	"github.com/stripe/goproxy"
	"github.com/stripe/smokescreen/v2/pkg/smokescreen"
	acl "github.com/stripe/smokescreen/v2/pkg/smokescreen/acl/v2"
	"github.com/stripe/smokescreen/v2/pkg/smokescreen/conntrack"
)

const upstreamHeader = "X-Upstream-Https-Proxy"

// Options configures Build.
type Options struct {
	// Authorizer judges every connection (Rules in production).
	Authorizer Authorizer
	// Principals maps egress tokens to sessions. Nil serves every request anonymously and ignores
	// Proxy-Authorization (the unit tests of the tunnel code; the command always sets it).
	Principals Principals
	// RequireAuth refuses a request without Proxy-Authorization instead of serving it anonymously (ADR 0036).
	RequireAuth bool
	// UpstreamAddr is the one fixed upstream proxy (OneCLI), host:port. It is
	// the only private address the proxy may dial, and only for route=onecli.
	// Empty (slice 3): no onecli route; a rule that selects it is a deny.
	UpstreamAddr string
	// OpenPrivateRanges lets private, ULA and CGNAT addresses through Smokescreen's own address check, because the
	// Authorizer judges them (private rules, the platform block list). Loopback, link-local, multicast and reserved
	// addresses stay refused by Smokescreen as a second layer. Leave it false when the Authorizer ignores addresses.
	OpenPrivateRanges bool
	// ResolveTimeout bounds the lookup of the destination's addresses (default 5 s).
	ResolveTimeout time.Duration
	MaxTunnelAge   time.Duration
	ConnectTimeout time.Duration
	IdleTimeout    time.Duration
	// UpstreamHandshakeTimeout bounds the CONNECT exchange with the upstream
	// (default 10 s). Without it an upstream that accepts TCP but never
	// answers would hold the tunnel until MaxTunnelAge.
	UpstreamHandshakeTimeout time.Duration
	Log                      *slog.Logger
	// Tweak lets tests adjust the Smokescreen config (resolver, address ranges).
	Tweak func(*smokescreen.Config)
}

// Proxy is the assembled egress proxy.
type Proxy struct {
	Registry *Registry

	opts        Options
	upstreamURL string
	inner       http.Handler
	baseDial    func(ctx context.Context, network, addr string) (net.Conn, error)
	resolver    smokescreen.Resolver
	network     string
}

// Build wires Smokescreen's proxy with our hooks. It does not listen.
func Build(o Options) (*Proxy, error) {
	if o.Authorizer == nil {
		return nil, errors.New("an authorizer is required")
	}
	var host, upstreamURL string
	if o.UpstreamAddr != "" {
		h, port, err := net.SplitHostPort(o.UpstreamAddr)
		if err != nil || h == "" || port == "" {
			return nil, fmt.Errorf("upstream address must be host:port: %q", o.UpstreamAddr)
		}
		host, upstreamURL = h, "http://"+o.UpstreamAddr
	}
	if o.ResolveTimeout == 0 {
		o.ResolveTimeout = 5 * time.Second
	}
	if o.ConnectTimeout == 0 {
		o.ConnectTimeout = 10 * time.Second
	}
	if o.UpstreamHandshakeTimeout == 0 {
		o.UpstreamHandshakeTimeout = 10 * time.Second
	}
	p := &Proxy{
		Registry:    NewRegistry(o.MaxTunnelAge),
		opts:        o,
		upstreamURL: upstreamURL,
	}
	// From authorization (stamped in serve) to Track a request spends at most
	// the connect timeout (which also bounds Smokescreen's resolve-and-dial)
	// plus, on the onecli route, the upstream handshake. The margin covers the
	// ACL decision and scheduling. The span is not strictly bounded: if a
	// stage outlasts its timeout the revocation entry may expire first and
	// that one tunnel then lives to maxAge.
	p.Registry.horizon = o.ConnectTimeout + o.UpstreamHandshakeTimeout + 30*time.Second

	cfg := smokescreen.NewConfig()
	if o.Log != nil {
		cfg.Log = o.Log
	}
	cfg.ConnectTimeout = o.ConnectTimeout
	cfg.IdleTimeout = o.IdleTimeout
	if o.OpenPrivateRanges {
		for _, pre := range privateRanges {
			_, n, err := net.ParseCIDR(pre.String())
			if err == nil {
				cfg.AllowRanges = append(cfg.AllowRanges, smokescreen.RuleRange{Net: *n})
			}
		}
	}
	cfg.EgressACL = &decider{p: p, upstreamHost: strings.ToLower(host)}
	cfg.RoleFromRequest = p.roleFromRequest
	cfg.UpstreamProxySelector = p.selectUpstream
	cfg.UpstreamProxyConnectReqHandler = p.authUpstream
	cfg.RejectResponseHandlerWithCtx = func(_ *smokescreen.SmokescreenContext, r *http.Response) {
		// Smokescreen answers every deny with 407. Only a proxy that asks for a token invites credentials.
		if r.StatusCode == http.StatusProxyAuthRequired && o.Principals != nil {
			r.Header.Set("Proxy-Authenticate", `Basic realm="egress"`)
		}
	}
	if o.Tweak != nil {
		o.Tweak(cfg)
	}
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	p.resolver, p.network = cfg.Resolver, cfg.Network
	// StartWithConfig sets these up; we run our own http.Server, so do it here.
	cfg.ConnTracker = conntrack.NewTracker(cfg.IdleTimeout, cfg.MetricsClient, cfg.ShuttingDown, nil)
	cfg.ShuttingDown.Store(false)

	gp := smokescreen.BuildProxy(cfg)
	p.baseDial = gp.Tr.DialContext
	gp.ConnectDialContext = p.dial
	p.inner = gp
	return p, nil
}

// Handler is the proxy's HTTP handler. Only CONNECT is served (plus /healthz).
func (p *Proxy) Handler() http.Handler { return http.HandlerFunc(p.serve) }

func (p *Proxy) serve(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet && r.URL.Path == "/healthz" && r.URL.Host == "" {
		w.WriteHeader(http.StatusOK)
		return
	}
	if r.Method != http.MethodConnect {
		http.Error(w, "only CONNECT is supported", http.StatusMethodNotAllowed)
		return
	}
	// A client must never choose the next hop. Del removes every value.
	r.Header.Del(upstreamHeader)
	// Stamped before the ACL decision, never in dial, so a close that lands
	// between the two still revokes this request. The state also carries the
	// addresses the decision checked to dial.
	r = r.WithContext(context.WithValue(r.Context(), stateKey{}, &reqState{authorizedAt: p.Registry.now()}))
	p.inner.ServeHTTP(w, r)
}

// roleFromRequest maps the egress token in Proxy-Authorization to a session (ADR 0036). The header is removed once
// read so nothing downstream can forward it, and no error text carries the token.
//
//   - No Proxy-Authorization: anonymous (only the rule sets that apply to all), unless RequireAuth, then 407.
//   - A Basic token that is unknown or revoked: 407. It never falls back to anonymous, so a revoked sandbox is not
//     quietly served with the open rules.
//   - A known token is accepted only from the sandbox Pod's address. A principal whose address is not recorded yet
//     is refused too (fail closed): the orchestrator records the address before it hands out the token.
func (p *Proxy) roleFromRequest(r *http.Request) (string, error) {
	h := r.Header.Get("Proxy-Authorization")
	r.Header.Del("Proxy-Authorization")
	if p.opts.Principals == nil {
		// No principals configured: everyone is anonymous; the header, if any, is dropped above.
		return AnonymousRole, nil
	}
	if h == "" {
		if p.opts.RequireAuth {
			return "", smokescreen.MissingRoleError("no Proxy-Authorization")
		}
		return AnonymousRole, nil
	}
	probe := http.Request{Header: http.Header{"Authorization": {h}}}
	_, token, ok := probe.BasicAuth()
	if !ok || token == "" {
		return "", errors.New("Proxy-Authorization is not Basic with a token")
	}
	pr, ok := p.opts.Principals.Lookup(token)
	if !ok {
		return "", errors.New("unknown or revoked egress token")
	}
	if !pr.PodIP.IsValid() {
		return "", errors.New("egress token refused: the sandbox's address is not recorded yet")
	}
	src, err := netip.ParseAddrPort(r.RemoteAddr)
	if err != nil || src.Addr().Unmap() != pr.PodIP {
		return "", errors.New("egress token refused: it is not valid from this address")
	}
	return pr.Session, nil
}

// principalOf is the principal behind a role: anonymous without Principals, otherwise the session's. ok is false for a
// session the snapshot no longer has (revoked between the token check and the decision): the caller denies.
func (p *Proxy) principalOf(role string) (Principal, bool) {
	if p.opts.Principals == nil || role == AnonymousRole {
		return Principal{}, true
	}
	return p.opts.Principals.BySession(role)
}

// selectUpstream chains route=onecli tunnels to the fixed upstream. An
// explicit direct route returns "". A host with no route cannot get here (the
// ACL denied it), but if the policy changed in between we return an address
// that cannot be dialled rather than fall through to a direct dial.
func (p *Proxy) selectUpstream(_ *smokescreen.SmokescreenContext, d *smokescreen.ACLDecision) string {
	host, port, ok := splitHostPort(d.OutboundHost)
	if !ok {
		return "http://deny.invalid:1"
	}
	pr, known := p.principalOf(d.Role)
	if !known {
		return "http://deny.invalid:1"
	}
	v := p.opts.Authorizer.Authorize(pr, normalizeHost(host), port, nil)
	switch {
	case v.Allow && v.Route == RouteDirect:
		return ""
	case v.Allow && v.Route == RouteOneCLI && p.upstreamURL != "":
		return p.upstreamURL
	default:
		return "http://deny.invalid:1"
	}
}

// authUpstream puts THIS session's OneCLI token on the CONNECT to the
// upstream. It runs per tunnel with that tunnel's context, so there is no
// shared state that two sessions could swap.
func (p *Proxy) authUpstream(ctx *goproxy.ProxyCtx, req *http.Request) error {
	d, err := decisionOf(ctx)
	if err != nil {
		return err
	}
	if p.upstreamURL == "" || d.SelectedUpstreamProxy != p.upstreamURL || d.Role == "" {
		return errors.New("tunnel is not routed to the upstream")
	}
	if p.opts.Principals == nil {
		return errors.New("no upstream token for session")
	}
	tok, ok := p.opts.Principals.OneCLIToken(d.Role)
	if !ok {
		return errors.New("no upstream token for session")
	}
	req.Header.Set("Proxy-Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte("x:"+tok)))
	return nil
}

// dial is goproxy's ConnectDialContext. It is the only place a tunnel's
// outbound connection is made, so it enforces three rules:
//   - route=onecli: the only address dialled is the fixed upstream, and it is
//     dialled directly, skipping Smokescreen's private-address denial (which
//     would refuse a ClusterIP). Anything else is refused, which also stops a
//     proxy env var (NO_PROXY) from turning the route into a direct dial.
//   - route=direct: the address must be the requested destination, and goes
//     through Smokescreen's resolve-classify-dial path.
//   - every connection is registered for revocation and maximum age.
func (p *Proxy) dial(pctx *goproxy.ProxyCtx, network, addr string) (net.Conn, error) {
	d, err := decisionOf(pctx)
	if err != nil {
		return nil, err
	}
	var c net.Conn
	if d.SelectedUpstreamProxy != "" {
		if d.SelectedUpstreamProxy != p.upstreamURL || addr != p.opts.UpstreamAddr || d.OutboundHost == addr {
			return nil, errors.New("onecli route may only dial the upstream")
		}
		dialer := net.Dialer{Timeout: p.opts.ConnectTimeout}
		c, err = dialer.DialContext(context.Background(), network, addr)
		if err == nil {
			// goproxy has no hook between its CONNECT write and the tunnel
			// being established, so the wrapper clears the deadline itself.
			c = newHandshakeConn(c, p.opts.UpstreamHandshakeTimeout)
		}
	} else {
		if addr != d.OutboundHost {
			return nil, errors.New("direct route may only dial the requested destination")
		}
		// Dial the address the decision checked, not whatever the name resolves to now: Smokescreen's dialContext
		// reuses ResolvedAddr when the address is the decision's own destination, so there is no second lookup an
		// attacker's DNS could answer differently (rebinding).
		if st := stateOf(pctx); st != nil && len(st.addrs) > 0 {
			_, port, ok := splitHostPort(addr)
			if !ok {
				return nil, errors.New("destination needs host:port")
			}
			d.ResolvedAddr = &net.TCPAddr{IP: net.IP(st.addrs[0].AsSlice()), Port: port}
		}
		ctx := context.WithValue(context.Background(), goproxy.ProxyContextKey, pctx)
		c, err = p.baseDial(ctx, network, addr)
	}
	if err != nil {
		return nil, err
	}
	st := stateOf(pctx)
	if st == nil {
		_ = c.Close()
		return nil, errors.New("tunnel has no authorization time")
	}
	return p.Registry.Track(d.Role, st.authorizedAt, c), nil
}

// reqState is what one CONNECT carries from the front handler through the ACL decision to the dial. The ACL
// decision (decider.Decide) is the only writer of addrs and it runs before the dial, on the same goroutine chain.
type reqState struct {
	authorizedAt time.Time
	// addrs are the destination's addresses as the decision checked them; the direct route dials the first.
	addrs []netip.Addr
}

type stateKey struct{}

func stateOf(pctx *goproxy.ProxyCtx) *reqState {
	if pctx == nil || pctx.Req == nil {
		return nil
	}
	return requestState(pctx.Req)
}

func requestState(r *http.Request) *reqState {
	st, _ := r.Context().Value(stateKey{}).(*reqState)
	return st
}

func decisionOf(pctx *goproxy.ProxyCtx) (*smokescreen.ACLDecision, error) {
	sctx, ok := pctx.UserData.(*smokescreen.SmokescreenContext)
	if !ok || sctx.Decision == nil || sctx.Decision.Role == "" {
		return nil, errors.New("tunnel has no decision")
	}
	return sctx.Decision, nil
}

func splitHostPort(hp string) (string, int, bool) {
	h, ps, err := net.SplitHostPort(hp)
	if err != nil {
		return "", 0, false
	}
	n, err := strconv.Atoi(ps)
	if err != nil {
		return "", 0, false
	}
	return h, n, true
}

// decider is Smokescreen's egress ACL: the session (role) must have a rule for
// the host and port. The upstream's own name is never a valid destination.
type decider struct {
	p            *Proxy
	upstreamHost string
}

func (d *decider) Decide(a acl.DecideArgs) (acl.Decision, error) {
	deny := func(why string) (acl.Decision, error) {
		return acl.Decision{Result: acl.Deny, Reason: why}, nil
	}
	if a.ConnectReq != nil || a.Req == nil {
		return deny("only plain CONNECT is allowed")
	}
	_, port, ok := splitHostPort(a.Req.Host)
	if !ok {
		return deny("destination needs host:port")
	}
	host := normalizeHost(a.Host)
	if d.upstreamHost != "" && host == d.upstreamHost {
		return deny("destination is not allowed")
	}
	st := requestState(a.Req)
	if st == nil {
		return deny("request has no state")
	}
	pr, known := d.p.principalOf(a.Service)
	if !known {
		return deny("the egress token was revoked")
	}
	az := d.p.opts.Authorizer

	// By name first: a host that no rule names is denied without a lookup, so the proxy is no DNS oracle.
	v := az.Authorize(pr, host, port, nil)
	if !v.Allow {
		return deny(v.Reason)
	}
	// Then by address: resolve here, judge every address, and keep them for the dial.
	rctx, cancel := context.WithTimeout(a.Req.Context(), d.p.opts.ResolveTimeout)
	defer cancel()
	ips, err := d.p.resolver.LookupIP(rctx, d.p.network, host)
	if err != nil || len(ips) == 0 {
		return deny("host does not resolve")
	}
	addrs := make([]netip.Addr, 0, len(ips))
	for _, ip := range ips {
		x, ok := netip.AddrFromSlice(ip)
		if !ok {
			return deny("host resolved to an unusable address")
		}
		addrs = append(addrs, x.Unmap())
	}
	v = az.Authorize(pr, host, port, addrStrings(addrs))
	if !v.Allow {
		return deny(v.Reason)
	}
	if v.Route == RouteOneCLI {
		switch {
		case d.upstreamHost == "":
			return deny("the onecli route arrives in slice 5; this proxy has no onecli upstream")
		case d.p.opts.Principals == nil:
			return deny("session has no upstream binding")
		default:
			if _, ok := d.p.opts.Principals.OneCLIToken(a.Service); !ok {
				return deny("session has no upstream binding")
			}
		}
	}
	st.addrs = addrs
	return acl.Decision{Result: acl.Allow, Reason: "allowed, route " + string(v.Route)}, nil
}

// handshakeConn applies a deadline to the CONNECT exchange with the upstream
// and clears it once the response header (ending in a blank line) has been
// read, so the established tunnel is bounded only by idle time and max age.
// goproxy reads the response on the same goroutine that then starts the
// tunnel, so no locking is needed.
type handshakeConn struct {
	net.Conn
	done bool
	tail [3]byte
	n    int // valid bytes in tail
}

func newHandshakeConn(c net.Conn, timeout time.Duration) *handshakeConn {
	_ = c.SetDeadline(time.Now().Add(timeout))
	return &handshakeConn{Conn: c}
}

func (h *handshakeConn) Read(b []byte) (int, error) {
	n, err := h.Conn.Read(b)
	if h.done || n == 0 {
		return n, err
	}
	// Scan the previous 3 bytes plus the new ones for the header terminator.
	buf := append(append(make([]byte, 0, h.n+n), h.tail[:h.n]...), b[:n]...)
	if strings.Contains(string(buf), "\r\n\r\n") {
		h.done = true
		_ = h.Conn.SetDeadline(time.Time{})
		return n, err
	}
	if len(buf) > 3 {
		buf = buf[len(buf)-3:]
	}
	h.n = copy(h.tail[:], buf)
	return n, err
}
