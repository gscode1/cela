package egress

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/netip"
	"os"
	"strings"
)

// Static is a fixed set of principals and per-session host rules, for tests of the proxy's CONNECT handling, token
// lookup and OneCLI chaining. It judges names only (the addresses are ignored), so a test can reach a loopback origin.
// The production authorizer is Rules (store.go).

// HostRule allows host (exact, or "*.suffix" for subdomains only) on the listed
// ports (empty means 443 only) via Route.
type HostRule struct {
	Host  string `json:"host"`
	Ports []int  `json:"ports,omitempty"`
	Route Route  `json:"route"`
}

// StaticConfig is the spike's file format for principals and rules.
type StaticConfig struct {
	Principals []StaticPrincipal     `json:"principals"`
	Rules      map[string][]HostRule `json:"rules"` // by session
}

type StaticPrincipal struct {
	Session     string `json:"session"`
	EgressToken string `json:"egressToken"`
	OneCLIToken string `json:"onecliToken,omitempty"`
	// PodIP is the address the token is bound to; the tests connect from loopback, which is the default.
	PodIP string `json:"podIP,omitempty"`
}

// Static implements Principals and Authorizer from a StaticConfig.
type Static struct {
	byHash map[string]Principal
	bySess map[string]Principal
	rules  map[string][]HostRule
}

func hashToken(t string) string {
	sum := sha256.Sum256([]byte(t))
	return hex.EncodeToString(sum[:])
}

// NewStatic validates the config. A token that is empty, or shared by two
// sessions, is an error: it would break the token-to-session guarantee.
func NewStatic(c StaticConfig) (*Static, error) {
	s := &Static{byHash: map[string]Principal{}, bySess: map[string]Principal{}, rules: map[string][]HostRule{}}
	for _, p := range c.Principals {
		if p.Session == "" || p.EgressToken == "" {
			return nil, fmt.Errorf("principal needs session and egressToken")
		}
		h := hashToken(p.EgressToken)
		if _, dup := s.byHash[h]; dup {
			return nil, fmt.Errorf("egress token shared by more than one session (%q)", p.Session)
		}
		if _, dup := s.bySess[p.Session]; dup {
			return nil, fmt.Errorf("duplicate session %q", p.Session)
		}
		ip := p.PodIP
		if ip == "" {
			ip = "127.0.0.1"
		}
		pr := Principal{Session: p.Session, OneCLIToken: p.OneCLIToken, PodIP: netip.MustParseAddr(ip)}
		s.byHash[h] = pr
		s.bySess[p.Session] = pr
	}
	for sess, rules := range c.Rules {
		for _, r := range rules {
			if r.Route != RouteDirect && r.Route != RouteOneCLI {
				return nil, fmt.Errorf("session %q host %q: unknown route %q", sess, r.Host, r.Route)
			}
			if r.Host == "" || strings.Contains(r.Host, ":") || strings.Count(r.Host, "*") > 1 ||
				(strings.Contains(r.Host, "*") && !strings.HasPrefix(r.Host, "*.")) {
				return nil, fmt.Errorf("session %q: bad host pattern %q", sess, r.Host)
			}
		}
		s.rules[sess] = rules
	}
	return s, nil
}

// LoadStatic reads a StaticConfig JSON file.
func LoadStatic(path string) (*Static, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var c StaticConfig
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&c); err != nil {
		return nil, err
	}
	return NewStatic(c)
}

func (s *Static) Lookup(egressToken string) (Principal, bool) {
	p, ok := s.byHash[hashToken(egressToken)]
	return p, ok
}

func (s *Static) BySession(session string) (Principal, bool) {
	p, ok := s.bySess[session]
	return p, ok
}

// Authorize judges by name: the session's first matching rule decides.
func (s *Static) Authorize(p Principal, host string, port int, _ []string) Decision {
	route, ok := s.Route(p.Session, host, port)
	if !ok {
		return Decision{Kind: KindDefaultDeny, Reason: "host not allowed for this session"}
	}
	return Decision{Allow: true, Route: route, Kind: KindAllowed, Reason: "allowed, route " + string(route)}
}

func (s *Static) OneCLIToken(session string) (string, bool) {
	p, ok := s.bySess[session]
	if !ok || p.OneCLIToken == "" {
		return "", false
	}
	return p.OneCLIToken, true
}

// Route finds the first rule of the session that matches. Hosts are compared
// lower-case, without a trailing dot.
func (s *Static) Route(session, host string, port int) (Route, bool) {
	host = strings.TrimSuffix(strings.ToLower(host), ".")
	for _, r := range s.rules[session] {
		if !staticHostMatches(r.Host, host) || !portAllowed(r.Ports, port) {
			continue
		}
		return r.Route, true
	}
	return "", false
}

func staticHostMatches(pattern, host string) bool {
	pattern = strings.ToLower(pattern)
	if suffix, ok := strings.CutPrefix(pattern, "*."); ok {
		return strings.HasSuffix(host, "."+suffix)
	}
	return pattern == host
}

func portAllowed(ports []int, port int) bool {
	if len(ports) == 0 {
		return port == 443
	}
	for _, p := range ports {
		if p == port {
			return true
		}
	}
	return false
}
