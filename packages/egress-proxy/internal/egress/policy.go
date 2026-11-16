// Package egress is the session egress proxy: Stripe Smokescreen's CONNECT
// handling plus our token-to-session mapping, per-session ACL, a chained
// upstream (OneCLI) and a tunnel registry.
package egress

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

// Route says how a tunnel leaves the proxy.
type Route string

const (
	// RouteDirect dials the origin itself, after Smokescreen's address checks.
	RouteDirect Route = "direct"
	// RouteOneCLI chains to the fixed OneCLI upstream with the session's own agent token.
	RouteOneCLI Route = "onecli"
)

// Principal is what an egress token stands for. OneCLIToken is the session's
// OneCLI agent token; it never reaches the sandbox.
type Principal struct {
	Session     string
	OneCLIToken string
}

// Principals maps an egress token (the secret the sandbox holds) to a Principal.
// The spike uses a static file; slice 4 replaces it with Postgres (token hash
// lookup) behind this same interface.
type Principals interface {
	Lookup(egressToken string) (Principal, bool)
	// OneCLIToken returns the upstream token bound to a session, if any.
	OneCLIToken(session string) (string, bool)
}

// Policy decides which hosts a session may reach and by which route. Deny by default.
type Policy interface {
	Route(session, host string, port int) (Route, bool)
}

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
}

// Static implements Principals and Policy from a StaticConfig.
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
		pr := Principal{Session: p.Session, OneCLIToken: p.OneCLIToken}
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
		if !hostMatches(r.Host, host) || !portAllowed(r.Ports, port) {
			continue
		}
		return r.Route, true
	}
	return "", false
}

func hostMatches(pattern, host string) bool {
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
