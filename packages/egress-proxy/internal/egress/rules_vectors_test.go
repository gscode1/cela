package egress

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
	"time"
)

// The shared vectors of the evaluator. packages/session-core/test/egress-vectors.test.ts runs the same file against
// evaluateEgress (TypeScript), so the admin API's explain and this proxy decide alike.
const vectorsPath = "../../../session-core/test/egress-vectors.json"

type vectorRule struct {
	ID        string  `json:"id"`
	RuleSet   *string `json:"ruleSet"`
	SessionID *string `json:"sessionId"`
	Effect    string  `json:"effect"`
	Host      string  `json:"host"`
	Ports     []int   `json:"ports"`
	Route     string  `json:"route"`
	Private   bool    `json:"private"`
	ExpiresAt *string `json:"expiresAt"`
}

type vectorFile struct {
	Now      string `json:"now"`
	RuleSets []struct {
		Name         string `json:"name"`
		AppliesToAll bool   `json:"appliesToAll"`
	} `json:"ruleSets"`
	Cases []struct {
		Name    string       `json:"name"`
		Rules   []vectorRule `json:"rules"`
		Request struct {
			Host            string   `json:"host"`
			Port            float64  `json:"port"`
			SessionID       string   `json:"sessionId"`
			ProfileRuleSets []string `json:"profileRuleSets"`
			Addresses       []string `json:"addresses"`
		} `json:"request"`
		Expect struct {
			Decision           string   `json:"decision"`
			Route              *string  `json:"route"`
			ReasonKind         string   `json:"reasonKind"`
			MatchedRuleID      *string  `json:"matchedRuleId"`
			ConflictingRuleIDs []string `json:"conflictingRuleIds"`
			NeedsPrivate       bool     `json:"needsPrivate"`
		} `json:"expect"`
	} `json:"cases"`
}

func TestEvaluateMatchesSharedVectors(t *testing.T) {
	t.Parallel()
	raw, err := os.ReadFile(vectorsPath)
	if err != nil {
		t.Fatal(err)
	}
	var v vectorFile
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	now, err := time.Parse(time.RFC3339, v.Now)
	if err != nil {
		t.Fatal(err)
	}
	if len(v.Cases) < 60 {
		t.Fatalf("only %d vectors", len(v.Cases))
	}
	var sets []RuleSet
	for _, s := range v.RuleSets {
		sets = append(sets, RuleSet{Name: s.Name, AppliesToAll: s.AppliesToAll})
	}
	for _, c := range v.Cases {
		t.Run(c.Name, func(t *testing.T) {
			var rules []Rule
			for _, r := range c.Rules {
				rule := Rule{ID: r.ID, Effect: r.Effect, Host: r.Host, Ports: r.Ports, Route: Route(r.Route), Private: r.Private}
				if r.RuleSet != nil {
					rule.RuleSet = *r.RuleSet
				}
				if r.SessionID != nil {
					rule.SessionID = *r.SessionID
				}
				if r.ExpiresAt != nil {
					at, err := time.Parse(time.RFC3339, *r.ExpiresAt)
					if err != nil {
						t.Fatal(err)
					}
					rule.ExpiresAt = &at
				}
				rules = append(rules, rule)
			}
			// A fractional port (44.5) cannot be an int: the TypeScript side calls it invalid, so does Go below.
			port := int(c.Request.Port)
			if float64(port) != c.Request.Port {
				port = -1
			}
			d := Evaluate(sets, rules, Request{
				Host: c.Request.Host, Port: port, SessionID: c.Request.SessionID,
				ProfileRuleSets: c.Request.ProfileRuleSets, Addresses: c.Request.Addresses, Now: now,
			})
			want := c.Expect
			if got := map[bool]string{true: "allow", false: "deny"}[d.Allow]; got != want.Decision {
				t.Errorf("decision %s, want %s (%s)", got, want.Decision, d.Reason)
			}
			wantRoute := ""
			if want.Route != nil {
				wantRoute = *want.Route
			}
			if string(d.Route) != wantRoute {
				t.Errorf("route %q, want %q", d.Route, wantRoute)
			}
			if string(d.Kind) != want.ReasonKind {
				t.Errorf("reason kind %s, want %s (%s)", d.Kind, want.ReasonKind, d.Reason)
			}
			wantID := ""
			if want.MatchedRuleID != nil {
				wantID = *want.MatchedRuleID
			}
			if d.MatchedRuleID != wantID {
				t.Errorf("matched rule %q, want %q", d.MatchedRuleID, wantID)
			}
			if !reflect.DeepEqual(append([]string(nil), d.ConflictingRuleIDs...), append([]string(nil), want.ConflictingRuleIDs...)) {
				t.Errorf("conflicting rules %v, want %v", d.ConflictingRuleIDs, want.ConflictingRuleIDs)
			}
			if d.NeedsPrivate != want.NeedsPrivate {
				t.Errorf("needsPrivate %v, want %v", d.NeedsPrivate, want.NeedsPrivate)
			}
		})
	}
}
