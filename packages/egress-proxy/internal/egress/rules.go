package egress

import (
	"fmt"
	"math"
	"net/netip"
	"regexp"
	"sort"
	"strings"
	"time"
)

// This file is the Go port of evaluateEgress in packages/session-core/src/egress-rules.ts (ADR 0034). The two must
// decide alike: packages/session-core/test/egress-vectors.json holds the shared vectors and both test suites run it.
// Change the rules of evaluation in both places and in the vectors, or not at all.

// Route says how a tunnel leaves the proxy.
type Route string

const (
	// RouteDirect dials the origin itself, on the address that was checked.
	RouteDirect Route = "direct"
	// RouteOneCLI chains to the fixed OneCLI upstream with the session's own agent token (slice 5).
	RouteOneCLI Route = "onecli"
)

// ReasonKind says why a decision came out as it did, as a stable word. The words are the TypeScript ones; KindStale
// is the proxy's own (no fresh rules, so everything is denied).
type ReasonKind string

const (
	KindAllowed          ReasonKind = "allowed"
	KindDefaultDeny      ReasonKind = "default-deny"
	KindDeniedByRule     ReasonKind = "denied-by-rule"
	KindConflictingRoute ReasonKind = "conflicting-routes"
	KindAlwaysBlocked    ReasonKind = "always-blocked"
	KindNeedsPrivate     ReasonKind = "needs-private"
	KindInvalidHost      ReasonKind = "invalid-host"
	KindInvalidPort      ReasonKind = "invalid-port"
	KindInvalidAddress   ReasonKind = "invalid-address"
	KindMixedRoutes      ReasonKind = "mixed-routes"
	KindStale            ReasonKind = "stale"
)

// RuleSet is a named group of rules. One that AppliesToAll covers every session.
type RuleSet struct {
	Name         string
	AppliesToAll bool
}

// Rule is one stored rule. Exactly one of RuleSet and SessionID is set. Host is lowercase: an exact name, a suffix
// with a leading dot, "*", or (private rules only) a cidr.
type Rule struct {
	ID        string
	RuleSet   string
	SessionID string
	Effect    string // "allow" or "deny"
	Host      string
	Ports     []int
	Route     Route
	Private   bool
	ExpiresAt *time.Time
}

// Request is one connection to judge. Addresses are what Host resolved to, as text; empty judges names only.
type Request struct {
	Host            string
	Port            int
	SessionID       string
	ProfileRuleSets []string
	Addresses       []string
	Now             time.Time
}

// Decision is the verdict. Route is empty for a deny.
type Decision struct {
	Allow              bool
	Route              Route
	MatchedRuleID      string
	RuleSet            string
	Kind               ReasonKind
	Reason             string
	ConflictingRuleIDs []string
	NeedsPrivate       bool
}

const anyHost = "*"

var labelRE = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)
var hexLabelRE = regexp.MustCompile(`^0x[0-9a-f]*$`)

func normalizeHost(host string) string {
	return strings.TrimSuffix(strings.ToLower(host), ".")
}

func allDigits(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

// dnsNameError is the reason a normalised host is not a DNS name, or "".
func dnsNameError(host string) string {
	if len(host) == 0 || len(host) > 253 {
		return "host must have 1 to 253 characters"
	}
	labels := strings.Split(host, ".")
	for _, l := range labels {
		if !labelRE.MatchString(l) {
			return "host must be a DNS name of lowercase letters, digits and hyphens"
		}
	}
	last := labels[len(labels)-1]
	if allDigits(last) || hexLabelRE.MatchString(last) {
		return "host must not be an IP address"
	}
	return ""
}

func mustPrefixes(list ...string) []netip.Prefix {
	out := make([]netip.Prefix, len(list))
	for i, s := range list {
		out[i] = netip.MustParsePrefix(s)
	}
	return out
}

// alwaysBlocked cannot be opened by any rule (ADR 0034). IPv4-mapped IPv6 is judged as the IPv4 address.
var alwaysBlocked = mustPrefixes(
	"0.0.0.0/8", "127.0.0.0/8", "169.254.0.0/16", "224.0.0.0/4", "240.0.0.0/4",
	"::/128", "::1/128", "fe80::/10", "fd00:ec2::254/128", "ff00::/8",
)

// privateRanges are denied unless a private rule allows them.
var privateRanges = mustPrefixes(
	"10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "192.0.0.0/24", "192.0.2.0/24",
	"198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "fc00::/7", "2001:db8::/32",
)

type addrClass int

const (
	classInvalid addrClass = iota
	classBlocked
	classPrivate
	classPublic
)

// parseAddr parses an IP address the way the TypeScript side does: no zone, no leading zeros, mapped IPv4 unwrapped.
func parseAddr(text string) (netip.Addr, bool) {
	a, err := netip.ParseAddr(strings.ToLower(text))
	if err != nil || a.Zone() != "" {
		return netip.Addr{}, false
	}
	return a.Unmap(), true
}

func inAny(list []netip.Prefix, a netip.Addr) bool {
	for _, p := range list {
		if p.Contains(a) {
			return true
		}
	}
	return false
}

func classify(a netip.Addr) addrClass {
	if inAny(alwaysBlocked, a) {
		return classBlocked
	}
	if inAny(privateRanges, a) {
		return classPrivate
	}
	return classPublic
}

func isCidr(r *Rule) bool { return strings.Contains(r.Host, "/") }

func hostMatches(r *Rule, host string) bool {
	if r.Host == anyHost {
		return true
	}
	if strings.HasPrefix(r.Host, ".") {
		return len(host) > len(r.Host) && strings.HasSuffix(host, r.Host)
	}
	return host == r.Host
}

// hostRank: exact first, then a cidr, then a longer suffix, then a shorter one, then "*".
func hostRank(r *Rule) int64 {
	switch {
	case r.Host == anyHost:
		return 0
	case isCidr(r):
		return math.MaxInt64 - 1
	case strings.HasPrefix(r.Host, "."):
		return int64(len(r.Host))
	default:
		return math.MaxInt64
	}
}

// idLess orders decimal ids numerically (shorter first, then lexicographic).
func idLess(a, b *Rule) bool {
	if len(a.ID) != len(b.ID) {
		return len(a.ID) < len(b.ID)
	}
	return a.ID < b.ID
}

func describe(r *Rule) string {
	owner := "rule set " + r.RuleSet
	if r.RuleSet == "" {
		owner = "session rule"
	}
	kind := "exact"
	switch {
	case r.Host == anyHost:
		kind = "any host"
	case isCidr(r):
		kind = "cidr"
	case strings.HasPrefix(r.Host, "."):
		kind = "suffix"
	}
	priv := ""
	if r.Private {
		priv = ", private"
	}
	return fmt.Sprintf("rule %s (%s, %s %s%s)", r.ID, owner, kind, r.Host, priv)
}

func deny(kind ReasonKind, reason string, rule *Rule) Decision {
	d := Decision{Kind: kind, Reason: reason}
	if rule != nil {
		d.MatchedRuleID = rule.ID
		d.RuleSet = rule.RuleSet
	}
	return d
}

func bestAllow(allows []*Rule, target string) (Decision, bool) {
	if len(allows) == 0 {
		return Decision{}, false
	}
	var bestHost int64 = -1
	for _, r := range allows {
		if rank := hostRank(r); rank > bestHost {
			bestHost = rank
		}
	}
	var same, own []*Rule
	for _, r := range allows {
		if hostRank(r) == bestHost {
			same = append(same, r)
			if r.RuleSet == "" {
				own = append(own, r)
			}
		}
	}
	best := same
	if len(own) > 0 {
		best = own // a session rule beats a rule set's rule
	}
	sort.SliceStable(best, func(i, j int) bool { return idLess(best[i], best[j]) })
	winner := best[0]
	for _, r := range best {
		if r.Route != winner.Route {
			parts := make([]string, len(best))
			ids := make([]string, len(best))
			for i, b := range best {
				parts[i] = describe(b)
				ids[i] = b.ID
			}
			d := deny(KindConflictingRoute, fmt.Sprintf("%s is denied: conflicting routes between %s", target, strings.Join(parts, " and ")), nil)
			d.ConflictingRuleIDs = ids
			return d, true
		}
	}
	return Decision{
		Allow: true, Route: winner.Route, MatchedRuleID: winner.ID, RuleSet: winner.RuleSet,
		Kind: KindAllowed, Reason: fmt.Sprintf("%s is allowed by %s", target, describe(winner)),
	}, true
}

// Evaluate judges one connection. Precedence (ADR 0034): an always-blocked address denies; else any matching deny;
// else the most specific allow (a session rule wins a tie with a rule set's; allows that disagree on the route deny);
// else deny. A public address is judged by the rules that are not private, a private address only by private rules,
// and every address must be allowed.
func Evaluate(sets []RuleSet, rules []Rule, req Request) Decision {
	host := normalizeHost(req.Host)
	target := fmt.Sprintf("%s:%d", host, req.Port)
	if req.Port < 1 || req.Port > 65535 {
		return deny(KindInvalidPort, fmt.Sprintf("port %d is not valid", req.Port), nil)
	}
	if e := dnsNameError(host); e != "" {
		return deny(KindInvalidHost, fmt.Sprintf("%s is denied: %s", target, e), nil)
	}

	active := map[string]bool{}
	named := map[string]bool{}
	for _, n := range req.ProfileRuleSets {
		named[n] = true
	}
	for _, s := range sets {
		if s.AppliesToAll || named[s.Name] {
			active[s.Name] = true
		}
	}
	session := strings.ToLower(req.SessionID)
	var owned []*Rule
	for i := range rules {
		r := &rules[i]
		if r.ExpiresAt != nil && !r.ExpiresAt.After(req.Now) {
			continue
		}
		if !hasPort(r.Ports, req.Port) {
			continue
		}
		if r.RuleSet == "" {
			if session == "" || r.SessionID != session {
				continue
			}
		} else if !active[r.RuleSet] {
			continue
		}
		owned = append(owned, r)
	}
	var byName []*Rule
	for _, r := range owned {
		if !isCidr(r) && hostMatches(r, host) {
			byName = append(byName, r)
		}
	}

	var firstDeny *Rule
	for _, r := range byName {
		if r.Effect != "deny" {
			continue
		}
		if firstDeny == nil || hostRank(r) > hostRank(firstDeny) || (hostRank(r) == hostRank(firstDeny) && idLess(r, firstDeny)) {
			firstDeny = r
		}
	}
	if firstDeny != nil {
		return deny(KindDeniedByRule, fmt.Sprintf("%s is denied by %s", target, describe(firstDeny)), firstDeny)
	}
	var allowsByName []*Rule
	for _, r := range byName {
		if r.Effect == "allow" {
			allowsByName = append(allowsByName, r)
		}
	}
	defaultDeny := func() Decision {
		return deny(KindDefaultDeny, fmt.Sprintf("%s matches no allow rule (default deny)", target), nil)
	}

	if len(req.Addresses) == 0 {
		if d, ok := bestAllow(allowsByName, target); ok {
			return d
		}
		return defaultDeny()
	}

	var result *Decision
	for _, text := range req.Addresses {
		addr, ok := parseAddr(text)
		if !ok {
			return deny(KindInvalidAddress, fmt.Sprintf("%s is denied: %q is not an IP address", target, truncate(text, 64)), nil)
		}
		var decision Decision
		switch classify(addr) {
		case classBlocked:
			return deny(KindAlwaysBlocked, fmt.Sprintf("%s is denied: it resolves to %s, an always-blocked address (loopback, link-local or metadata, multicast or reserved) that no rule can allow", target, text), nil)
		case classPublic:
			var pub []*Rule
			for _, r := range allowsByName {
				if !r.Private {
					pub = append(pub, r)
				}
			}
			d, found := bestAllow(pub, target)
			if !found {
				d = defaultDeny()
			}
			decision = d
		default:
			var candidates []*Rule
			for _, r := range owned {
				if r.Effect != "allow" || !r.Private {
					continue
				}
				if isCidr(r) {
					p, err := netip.ParsePrefix(r.Host)
					if err != nil || !p.Contains(addr) {
						continue
					}
				} else if !hostMatches(r, host) {
					continue
				}
				candidates = append(candidates, r)
			}
			d, found := bestAllow(candidates, target)
			if !found {
				d = deny(KindNeedsPrivate, fmt.Sprintf("%s resolves to %s, a private address; it needs an allow rule with private: true (an exact host or a cidr that contains it)", target, text), nil)
				d.NeedsPrivate = true
			} else if d.Allow {
				d.NeedsPrivate = true
			}
			decision = d
		}
		if !decision.Allow {
			return decision
		}
		if result != nil && result.Route != decision.Route {
			return deny(KindMixedRoutes, fmt.Sprintf("%s is denied: its addresses need different routes (%s and %s)", target, result.Route, decision.Route), nil)
		}
		if result == nil {
			d := decision
			result = &d
		}
	}
	if result == nil {
		return defaultDeny()
	}
	return *result
}

func hasPort(ports []int, p int) bool {
	for _, q := range ports {
		if q == p {
			return true
		}
	}
	return false
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}
