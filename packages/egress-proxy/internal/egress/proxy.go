package egress

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
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
	Principals Principals
	Policy     Policy
	// UpstreamAddr is the one fixed upstream proxy (OneCLI), host:port. It is
	// the only private address the proxy may dial, and only for route=onecli.
	UpstreamAddr   string
	MaxTunnelAge   time.Duration
	ConnectTimeout time.Duration
	IdleTimeout    time.Duration
	Log            *slog.Logger
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
}

// Build wires Smokescreen's proxy with our hooks. It does not listen.
func Build(o Options) (*Proxy, error) {
	if o.Principals == nil || o.Policy == nil {
		return nil, errors.New("principals and policy are required")
	}
	host, port, err := net.SplitHostPort(o.UpstreamAddr)
	if err != nil || host == "" || port == "" {
		return nil, fmt.Errorf("upstream address must be host:port: %q", o.UpstreamAddr)
	}
	if o.ConnectTimeout == 0 {
		o.ConnectTimeout = 10 * time.Second
	}
	p := &Proxy{
		Registry:    NewRegistry(o.MaxTunnelAge),
		opts:        o,
		upstreamURL: "http://" + o.UpstreamAddr,
	}

	cfg := smokescreen.NewConfig()
	if o.Log != nil {
		cfg.Log = o.Log
	}
	cfg.ConnectTimeout = o.ConnectTimeout
	cfg.IdleTimeout = o.IdleTimeout
	cfg.EgressACL = &decider{p: p, upstreamHost: strings.ToLower(host)}
	cfg.RoleFromRequest = p.roleFromRequest
	cfg.UpstreamProxySelector = p.selectUpstream
	cfg.UpstreamProxyConnectReqHandler = p.authUpstream
	cfg.RejectResponseHandlerWithCtx = func(_ *smokescreen.SmokescreenContext, r *http.Response) {
		if r.StatusCode == http.StatusProxyAuthRequired {
			r.Header.Set("Proxy-Authenticate", `Basic realm="egress"`)
		}
	}
	if o.Tweak != nil {
		o.Tweak(cfg)
	}
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
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
	p.inner.ServeHTTP(w, r)
}

// roleFromRequest maps the egress token in Proxy-Authorization to a session.
// The header is removed once read so nothing downstream can forward it.
func (p *Proxy) roleFromRequest(r *http.Request) (string, error) {
	h := r.Header.Get("Proxy-Authorization")
	r.Header.Del("Proxy-Authorization")
	if h == "" {
		return "", smokescreen.MissingRoleError("no Proxy-Authorization")
	}
	probe := http.Request{Header: http.Header{"Authorization": {h}}}
	_, token, ok := probe.BasicAuth()
	if !ok || token == "" {
		return "", errors.New("Proxy-Authorization is not Basic with a token")
	}
	pr, ok := p.opts.Principals.Lookup(token)
	if !ok {
		return "", errors.New("unknown egress token")
	}
	return pr.Session, nil
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
	route, ok := p.opts.Policy.Route(d.Role, host, port)
	switch {
	case ok && route == RouteDirect:
		return ""
	case ok && route == RouteOneCLI:
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
	if d.SelectedUpstreamProxy != p.upstreamURL || d.Role == "" {
		return errors.New("tunnel is not routed to the upstream")
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
	} else {
		if addr != d.OutboundHost {
			return nil, errors.New("direct route may only dial the requested destination")
		}
		ctx := context.WithValue(context.Background(), goproxy.ProxyContextKey, pctx)
		c, err = p.baseDial(ctx, network, addr)
	}
	if err != nil {
		return nil, err
	}
	return p.Registry.Track(d.Role, c), nil
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
	host := strings.TrimSuffix(strings.ToLower(a.Host), ".")
	if host == d.upstreamHost {
		return deny("destination is not allowed")
	}
	route, ok := d.p.opts.Policy.Route(a.Service, host, port)
	if !ok {
		return deny("host not allowed for this session")
	}
	if route == RouteOneCLI {
		if _, ok := d.p.opts.Principals.OneCLIToken(a.Service); !ok {
			return deny("session has no upstream binding")
		}
	}
	return acl.Decision{Result: acl.Allow, Reason: "allowed, route " + string(route)}, nil
}
