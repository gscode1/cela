package egress

import "testing"

func TestStaticRejectsSharedTokenAndBadRules(t *testing.T) {
	t.Parallel()
	if _, err := NewStatic(StaticConfig{Principals: []StaticPrincipal{
		{Session: "a", EgressToken: "same"}, {Session: "b", EgressToken: "same"},
	}}); err == nil {
		t.Error("two sessions with one token must be rejected")
	}
	if _, err := NewStatic(StaticConfig{Principals: []StaticPrincipal{{Session: "a"}}}); err == nil {
		t.Error("empty token must be rejected")
	}
	for _, r := range []HostRule{
		{Host: "x.example", Route: "other"}, {Host: "*", Route: RouteDirect},
		{Host: "a*.example", Route: RouteDirect}, {Host: "x.example:443", Route: RouteDirect},
	} {
		if _, err := NewStatic(StaticConfig{Rules: map[string][]HostRule{"a": {r}}}); err == nil {
			t.Errorf("rule %+v must be rejected", r)
		}
	}
}

func TestRouteMatching(t *testing.T) {
	t.Parallel()
	s, err := NewStatic(StaticConfig{Rules: map[string][]HostRule{"a": {
		{Host: "github.com", Route: RouteOneCLI},
		{Host: "*.example.org", Ports: []int{8443}, Route: RouteDirect},
	}}})
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		sess, host string
		port       int
		route      Route
		ok         bool
	}{
		{"a", "github.com", 443, RouteOneCLI, true},
		{"a", "GitHub.com.", 443, RouteOneCLI, true},
		{"a", "github.com", 80, "", false},
		{"a", "evilgithub.com", 443, "", false},
		{"a", "api.github.com", 443, "", false},
		{"a", "x.example.org", 8443, RouteDirect, true},
		{"a", "example.org", 8443, "", false}, // suffix rule never matches the apex
		{"a", "x.example.org", 443, "", false},
		{"b", "github.com", 443, "", false},
	}
	for _, c := range cases {
		r, ok := s.Route(c.sess, c.host, c.port)
		if r != c.route || ok != c.ok {
			t.Errorf("%+v: got %q %v", c, r, ok)
		}
	}
}
