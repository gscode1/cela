package egress

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stripe/smokescreen/v2/pkg/smokescreen"
)

type sourceFunc func() (*Snapshot, bool)

func (f sourceFunc) Current() (*Snapshot, bool) { return f() }

// sequenceResolver answers each lookup of a name from the next entry of its list (the last one repeats): a name whose
// answer changes between two lookups, which is what DNS rebinding looks like.
type sequenceResolver struct {
	mu    sync.Mutex
	calls map[string]int
	data  map[string][]string
}

func (r *sequenceResolver) LookupPort(_ context.Context, _, service string) (int, error) {
	return fakeResolver{}.LookupPort(context.Background(), "", service)
}

func (r *sequenceResolver) LookupIP(_ context.Context, _, host string) ([]net.IP, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if ip := net.ParseIP(host); ip != nil {
		return []net.IP{ip}, nil
	}
	list, ok := r.data[host]
	if !ok {
		return nil, fmt.Errorf("no such host %s", host)
	}
	i := r.calls[host]
	r.calls[host]++
	if i >= len(list) {
		i = len(list) - 1
	}
	var out []net.IP
	for _, s := range strings.Split(list[i], ",") {
		out = append(out, net.ParseIP(s))
	}
	return out, nil
}

type rulesEnv struct {
	proxyAddr string
	origin    *fakeOrigin
	dialed    func() []string
	p         *Proxy
}

type rulesEnvOpts struct {
	snap     *Snapshot
	stale    *atomic.Bool
	platform *Platform
	dns      map[string][]string
	// principals serves the snapshot's principals (production wiring); requireAuth refuses anonymous requests.
	principals  bool
	requireAuth bool
	logs        io.Writer
	// live, when set, replaces snap as the snapshot in use (a test swaps it, like the loader does).
	live *atomic.Pointer[Snapshot]
	// upstream is the OneCLI stand-in's address (host:port); bindingKey opens the snapshot's bindings.
	upstream   string
	bindingKey []byte
	// source replaces the snapshot source (a Loader); onDial runs inside the direct dial, between the ACL decision and
	// the tunnel being tracked.
	source SnapshotSource
	onDial func()
}

// newRulesEnv serves the production wiring (Rules, anonymous principals, private ranges opened to the evaluator). The
// dial is redirected to a fake origin and recorded, so a test sees which address the proxy chose to connect to.
func newRulesEnv(t *testing.T, o rulesEnvOpts) *rulesEnv {
	t.Helper()
	origin := newFakeOrigin(t)
	var mu sync.Mutex
	var dialed []string
	var src SnapshotSource = sourceFunc(func() (*Snapshot, bool) {
		if o.stale != nil && o.stale.Load() {
			return nil, false
		}
		if o.live != nil {
			return o.live.Load(), true
		}
		return o.snap, true
	})
	if o.source != nil {
		src = o.source
	}
	dns := &sequenceResolver{calls: map[string]int{}, data: o.dns}
	var principals Principals
	if o.principals {
		principals = SnapshotPrincipals{Source: src, BindingKey: o.bindingKey}
	}
	logs := o.logs
	if logs == nil {
		logs = io.Discard
	}
	p, err := Build(Options{
		Authorizer:        &Rules{Source: src, Platform: o.platform, Now: time.Now},
		Principals:        principals,
		RequireAuth:       o.requireAuth,
		UpstreamAddr:      o.upstream,
		OpenPrivateRanges: true,
		Log:               slog.New(slog.NewTextHandler(logs, nil)),
		Tweak: func(c *smokescreen.Config) {
			c.Resolver = dns
			c.ProxyDialTimeout = func(_ context.Context, network, address string, timeout time.Duration) (net.Conn, error) {
				mu.Lock()
				dialed = append(dialed, address)
				mu.Unlock()
				if o.onDial != nil {
					o.onDial()
				}
				return net.DialTimeout(network, origin.ln.Addr().String(), timeout)
			}
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(p.Handler())
	t.Cleanup(srv.Close)
	return &rulesEnv{
		proxyAddr: strings.TrimPrefix(srv.URL, "http://"),
		origin:    origin,
		p:         p,
		dialed: func() []string {
			mu.Lock()
			defer mu.Unlock()
			return append([]string(nil), dialed...)
		},
	}
}

func allowRule(id, set, host string, ports ...int) Rule {
	if len(ports) == 0 {
		ports = []int{443}
	}
	return Rule{ID: id, RuleSet: set, Effect: "allow", Host: host, Ports: ports, Route: RouteDirect}
}

func baseSnapshot(rules ...Rule) *Snapshot {
	return &Snapshot{Revision: 5, RuleSets: []RuleSet{{Name: "all", AppliesToAll: true}, {Name: "prof"}}, Rules: rules}
}

func TestProxyAllowsRuleHostAndDialsTheCheckedAddress(t *testing.T) {
	t.Parallel()
	e := newRulesEnv(t, rulesEnvOpts{
		snap: baseSnapshot(allowRule("1", "all", "ok.example.com")),
		// The second lookup (Smokescreen's own) answers in another order: it picks 8.8.8.8, which the decision also
		// checked, so that is what is dialled.
		dns: map[string][]string{"ok.example.com": {"93.184.216.34,8.8.8.8", "8.8.8.8,93.184.216.34"}},
	})
	c, br, status, _ := connect(t, e.proxyAddr, "ok.example.com:443", "")
	if status != http.StatusOK {
		t.Fatalf("status %d, want 200", status)
	}
	if got := get(t, c, br, "/"); got != http.StatusOK {
		t.Errorf("origin answered %d", got)
	}
	if d := e.dialed(); len(d) != 1 || d[0] != "8.8.8.8:443" {
		t.Errorf("dialled %v, want exactly the address both checks approved, 8.8.8.8:443", d)
	}
}

// DNS rebinding: the two lookups share no address and the second one is an address the rules deny (private, platform),
// so the address Smokescreen picked was never approved.
func TestProxyRefusesWhenTheTwoLookupsDisagreeOnADeniedAddress(t *testing.T) {
	t.Parallel()
	platform := &Platform{Hosts: []string{"10.96.1.5"}}
	if err := platform.Refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	for name, second := range map[string]string{
		"private":  "10.0.0.5",
		"platform": "10.96.1.5",
		"mixed":    "93.184.216.35,10.0.0.5", // Smokescreen skips the private one, but the decision never judged the public one
	} {
		e := newRulesEnv(t, rulesEnvOpts{
			platform: platform,
			snap:     baseSnapshot(allowRule("1", "all", "ok.example.com")),
			dns:      map[string][]string{"ok.example.com": {"93.184.216.34", second}},
		})
		_, _, status, _ := connect(t, e.proxyAddr, "ok.example.com:443", "")
		if name == "mixed" {
			// 93.184.216.35 is public and allowed by the rule on its own: judged and dialled, the 10.0.0.5 is never used.
			if d := e.dialed(); len(d) != 1 || d[0] != "93.184.216.35:443" {
				t.Errorf("%s: dialled %v", name, d)
			}
			continue
		}
		if status == http.StatusOK {
			t.Errorf("%s: status 200, want a refusal", name)
		}
		if d := e.dialed(); len(d) != 0 {
			t.Errorf("%s: dialled %v", name, d)
		}
	}
}

// #412: a host whose DNS answers one rotating address per query (allegro.pl) gives disjoint answers to the decision and
// to Smokescreen. The picked address is judged on its own and dialled; nothing the rules deny is.
func TestProxyTunnelsWhenTheTwoLookupsRotate(t *testing.T) {
	t.Parallel()
	cases := map[string]struct {
		dns  []string
		want string
	}{
		"single address rotates":   {[]string{"185.31.27.160", "5.134.213.80"}, "5.134.213.80:443"},
		"different order":          {[]string{"93.184.216.34,8.8.8.8", "8.8.8.8,93.184.216.34"}, "8.8.8.8:443"},
		"rotating subsets overlap": {[]string{"8.8.8.8,93.184.216.34", "93.184.216.34,1.1.1.1"}, "93.184.216.34:443"},
		"A then A plus AAAA":       {[]string{"185.31.27.160", "2606:4700::6810:84e5,185.31.27.160"}, "[2606:4700::6810:84e5]:443"},
		"mapped then plain":        {[]string{"::ffff:93.184.216.34", "93.184.216.34"}, "93.184.216.34:443"},
		"plain then mapped":        {[]string{"93.184.216.34", "::ffff:93.184.216.34"}, "93.184.216.34:443"},
		"disjoint v4 and v6":       {[]string{"93.184.216.34", "2606:4700::6810:84e5"}, "[2606:4700::6810:84e5]:443"},
	}
	for name, c := range cases {
		e := newRulesEnv(t, rulesEnvOpts{
			snap: baseSnapshot(allowRule("1", "all", "ok.example.com")),
			dns:  map[string][]string{"ok.example.com": c.dns},
		})
		_, _, status, _ := connect(t, e.proxyAddr, "ok.example.com:443", "")
		if status != http.StatusOK {
			t.Errorf("%s: status %d, want 200", name, status)
		}
		if d := e.dialed(); len(d) != 1 || d[0] != c.want {
			t.Errorf("%s: dialled %v, want %s", name, d, c.want)
		}
	}
}

// #373: an IPv6 address that embeds an IPv4 one (NAT64, 6to4, Teredo, SIIT, IPv4-compatible) is judged by that IPv4
// address too, and the address dialled is the one Smokescreen approved, never another of the answer.
func TestProxyJudgesIPv4EmbeddedInIPv6(t *testing.T) {
	t.Parallel()
	platform := &Platform{Hosts: []string{"10.96.1.5"}}
	if err := platform.Refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	dns := map[string][]string{
		// The answer of the issue: a NAT64 address of 10.0.0.5 next to a public one.
		"nat64-mixed.example.com":    {"64:ff9b::a00:5,93.184.216.34"},
		"nat64-loop.example.com":     {"64:ff9b::7f00:1"},
		"nat64-meta.example.com":     {"64:ff9b::a9fe:a9fe"},
		"nat64-local.example.com":    {"64:ff9b:1::808:808"},
		"nat64-platform.example.com": {"64:ff9b::a60:105"},
		"sixtofour.example.com":      {"2002:a00:5::1,93.184.216.34"},
		"teredo-server.example.com":  {"2001:0:a00:5::f7f7:f7f7"},
		"teredo-client.example.com":  {"2001:0:808:808::f5ff:fffa"},
		"siit.example.com":           {"::ffff:0:a00:5"},
		"compat.example.com":         {"::a00:5"},
	}
	e := newRulesEnv(t, rulesEnvOpts{
		platform: platform,
		dns:      dns,
		snap: baseSnapshot(
			Rule{ID: "1", RuleSet: "all", Effect: "allow", Host: "*", Ports: []int{443}, Route: RouteDirect},
			// The platform address stays out of reach even for a name a private rule allows.
			Rule{ID: "2", RuleSet: "all", Effect: "allow", Host: "nat64-platform.example.com", Ports: []int{443}, Route: RouteDirect, Private: true},
		),
	})
	for name := range dns {
		_, _, status, _ := connect(t, e.proxyAddr, name+":443", "")
		if status != http.StatusProxyAuthRequired {
			t.Errorf("%s: status %d, want a deny (407)", name, status)
		}
	}
	if d := e.dialed(); len(d) != 0 {
		t.Errorf("dialled %v", d)
	}
}

// A NAT64 address of a public IPv4 passes the decision, but Smokescreen skips it: the dial uses the address
// Smokescreen picked, not the first of the answer.
func TestProxyDialsTheAddressSmokescreenApproved(t *testing.T) {
	t.Parallel()
	e := newRulesEnv(t, rulesEnvOpts{
		snap: baseSnapshot(allowRule("1", "all", "ok.example.com")),
		dns:  map[string][]string{"ok.example.com": {"64:ff9b::808:808,93.184.216.34"}},
	})
	_, _, status, _ := connect(t, e.proxyAddr, "ok.example.com:443", "")
	if status != http.StatusOK {
		t.Fatalf("status %d, want 200", status)
	}
	if d := e.dialed(); len(d) != 1 || d[0] != "93.184.216.34:443" {
		t.Errorf("dialled %v, want 93.184.216.34:443", d)
	}
}

func TestProxyIgnoresAnyProxyAuthorizationInThisSlice(t *testing.T) {
	t.Parallel()
	e := newRulesEnv(t, rulesEnvOpts{
		snap: baseSnapshot(allowRule("1", "all", "ok.example.com")),
		dns:  map[string][]string{"ok.example.com": {"93.184.216.34"}},
	})
	_, _, status, _ := connect(t, e.proxyAddr, "ok.example.com:443", "Basic !!!")
	if status != http.StatusOK {
		t.Errorf("status %d, want 200: anonymous requests are judged without their credentials", status)
	}
}

func TestProxyDeniesWhatNoRuleAllows(t *testing.T) {
	t.Parallel()
	e := newRulesEnv(t, rulesEnvOpts{
		snap: baseSnapshot(
			allowRule("1", "all", "ok.example.com"),
			allowRule("2", "prof", "profile-only.example.com"),
			Rule{ID: "3", SessionID: "11111111-1111-4111-8111-111111111111", Effect: "allow", Host: "session-only.example.com", Ports: []int{443}, Route: RouteDirect},
			Rule{ID: "4", RuleSet: "all", Effect: "deny", Host: "ok.example.com", Ports: []int{8443}, Route: RouteDirect},
			Rule{ID: "5", RuleSet: "all", Effect: "allow", Host: "onecli.example.com", Ports: []int{443}, Route: RouteOneCLI},
		),
		dns: map[string][]string{
			"ok.example.com": {"93.184.216.34"}, "profile-only.example.com": {"93.184.216.34"},
			"session-only.example.com": {"93.184.216.34"}, "unruled.example.com": {"93.184.216.34"},
			"onecli.example.com": {"93.184.216.34"},
		},
	})
	for _, target := range []string{
		"unruled.example.com:443",      // no rule
		"ok.example.com:8443",          // port not listed
		"profile-only.example.com:443", // a profile's set does not apply to an anonymous request
		"session-only.example.com:443", // a session's rule does not apply without a session
		"onecli.example.com:443",       // the onecli route arrives in slice 5
		"nowhere.example.com:443",      // does not resolve
		"93.184.216.34:443",            // an IP literal is never a rule's host
		"[2606:4700::1111]:443",        // IPv6 literal
		"ok.example.com.evil.test:443", // look-alike
		"OK.EXAMPLE.COM.EVIL.TEST:443",
	} {
		_, _, status, _ := connect(t, e.proxyAddr, target, "")
		if status != http.StatusProxyAuthRequired {
			t.Errorf("%s: status %d, want a deny (407)", target, status)
		}
	}
	if len(e.dialed()) != 0 || e.origin.count() != 0 {
		t.Errorf("a denied request was dialled: %v", e.dialed())
	}
}

func TestProxyNeverReachesSpecialAddressesEvenWithAnOpenWebRule(t *testing.T) {
	t.Parallel()
	platform := &Platform{Hosts: []string{"10.96.1.5", "10.96.0.1"}, Prefixes: []netip.Prefix{netip.MustParsePrefix("10.244.7.0/24")}}
	if err := platform.Refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	dns := map[string][]string{
		"loop.example.com": {"127.0.0.1"}, "metadata.example.com": {"169.254.169.254"},
		"mapped.example.com": {"::ffff:127.0.0.1"}, "private.example.com": {"10.1.2.3"},
		"cgnat.example.com": {"100.64.0.9"}, "multicast.example.com": {"224.0.0.1"},
		"postgres.example.com": {"10.96.1.5"}, "kubeapi.example.com": {"10.96.0.1"}, "pod.example.com": {"10.244.7.9"},
		"mixed.example.com": {"93.184.216.34,127.0.0.1"}, "v6loop.example.com": {"::1"},
	}
	e := newRulesEnv(t, rulesEnvOpts{
		platform: platform,
		dns:      dns,
		snap: baseSnapshot(
			Rule{ID: "1", RuleSet: "all", Effect: "allow", Host: "*", Ports: []int{443}, Route: RouteDirect},
			// An operator-approved private cidr that is far too wide: it covers the platform.
			Rule{ID: "2", RuleSet: "all", Effect: "allow", Host: "10.0.0.0/8", Ports: []int{443}, Route: RouteDirect, Private: true},
		),
	})
	for name := range dns {
		if name == "private.example.com" {
			continue // covered by the private-tier test
		}
		_, _, status, _ := connect(t, e.proxyAddr, name+":443", "")
		if status != http.StatusProxyAuthRequired {
			t.Errorf("%s: status %d, want a deny (407)", name, status)
		}
	}
	if len(e.dialed()) != 0 {
		t.Errorf("dialled %v", e.dialed())
	}
}

func TestProxyPrivateTierNeedsAPrivateRule(t *testing.T) {
	t.Parallel()
	dns := map[string][]string{
		"svc.internal.example": {"10.1.2.3"}, "other.internal.example": {"10.1.2.4"}, "in-cidr.example.com": {"10.20.3.4"},
		"wide.example.com": {"10.1.2.3"},
	}
	e := newRulesEnv(t, rulesEnvOpts{
		dns: dns,
		snap: baseSnapshot(
			Rule{ID: "1", RuleSet: "all", Effect: "allow", Host: "*", Ports: []int{443}, Route: RouteDirect},
			Rule{ID: "2", RuleSet: "all", Effect: "allow", Host: "svc.internal.example", Ports: []int{8080}, Route: RouteDirect, Private: true},
			Rule{ID: "3", RuleSet: "all", Effect: "allow", Host: "10.20.0.0/16", Ports: []int{443}, Route: RouteDirect, Private: true},
		),
	})
	allowed := map[string]bool{"svc.internal.example:8080": true, "in-cidr.example.com:443": true}
	for _, target := range []string{"svc.internal.example:8080", "in-cidr.example.com:443", "svc.internal.example:443", "other.internal.example:8080", "wide.example.com:443"} {
		_, _, status, _ := connect(t, e.proxyAddr, target, "")
		if allowed[target] && status != http.StatusOK {
			t.Errorf("%s: status %d, want 200", target, status)
		}
		if !allowed[target] && status != http.StatusProxyAuthRequired {
			t.Errorf("%s: status %d, want a deny", target, status)
		}
	}
	got := e.dialed()
	if len(got) != 2 || got[0] != "10.1.2.3:8080" || got[1] != "10.20.3.4:443" {
		t.Errorf("dialled %v", got)
	}
}

func TestProxyDeniesEverythingWithoutFreshRules(t *testing.T) {
	t.Parallel()
	var stale atomic.Bool
	e := newRulesEnv(t, rulesEnvOpts{
		stale: &stale,
		snap:  baseSnapshot(allowRule("1", "all", "ok.example.com")),
		dns:   map[string][]string{"ok.example.com": {"93.184.216.34"}},
	})
	if _, _, status, _ := connect(t, e.proxyAddr, "ok.example.com:443", ""); status != http.StatusOK {
		t.Fatalf("status %d before the rules went stale", status)
	}
	stale.Store(true)
	if _, _, status, _ := connect(t, e.proxyAddr, "ok.example.com:443", ""); status != http.StatusProxyAuthRequired {
		t.Errorf("status %d, want a deny once the rules are stale", status)
	}
}

func TestRulesAuthorizeExplainsStaleness(t *testing.T) {
	t.Parallel()
	r := &Rules{Source: sourceFunc(func() (*Snapshot, bool) { return nil, false })}
	d := r.Authorize(Principal{}, "ok.example.com", 443, nil)
	if d.Allow || d.Kind != KindStale {
		t.Errorf("decision %+v", d)
	}
}

func TestClassifyJudgesEmbeddedIPv4(t *testing.T) {
	t.Parallel()
	for text, want := range map[string]addrClass{
		"64:ff9b::808:808":          classPublic,
		"64:ff9b::a00:5":            classPrivate,
		"64:ff9b::7f00:1":           classBlocked,
		"64:ff9b::a9fe:a9fe":        classBlocked,
		"64:ff9b:1::808:808":        classPrivate,
		"64:ff9b:1::7f00:1":         classBlocked,
		"2002:808:808::1":           classPublic,
		"2002:a00:5::1":             classPrivate,
		"2002:7f00:1::1":            classBlocked,
		"2001:0:808:808::f7f7:f7f7": classPublic,
		"2001:0:a00:5::f7f7:f7f7":   classPrivate,
		"2001:0:808:808::f5ff:fffa": classPrivate,
		"2001:0:808:808::80ff:fffe": classBlocked,
		"::ffff:0:a00:5":            classPrivate,
		"::a00:5":                   classPrivate,
		"::7f00:1":                  classBlocked,
		"2001:db8::1":               classPrivate,
		"2606:4700::1111":           classPublic,
	} {
		a, ok := parseAddr(text)
		if !ok {
			t.Fatalf("%s does not parse", text)
		}
		if got := classify(a); got != want {
			t.Errorf("classify(%s) = %d, want %d", text, got, want)
		}
	}
}
