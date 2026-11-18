package egress

import (
	"encoding/json"
	"fmt"
	"net/netip"
	"strings"
	"time"
)

// Snapshot is the rules at one revision, as read in one statement.
type Snapshot struct {
	Revision int64
	RuleSets []RuleSet
	Rules    []Rule
	// Invalid counts the stored rows that were left out because they do not pass the rule shape checks; the
	// admin API reports the same rows as invalid, and the evaluation of explain skips them too.
	Invalid int
}

type setRow struct {
	Name         string `json:"name"`
	AppliesToAll bool   `json:"applies_to_all"`
}

type ruleRow struct {
	ID            json.Number `json:"id"`
	RuleSet       *string     `json:"rule_set"`
	SessionID     *string     `json:"session_id"`
	Effect        string      `json:"effect"`
	Host          string      `json:"host"`
	Ports         []int       `json:"ports"`
	Route         string      `json:"route"`
	AllowsPrivate bool        `json:"allows_private"`
	ExpiresAt     *string     `json:"expires_at"`
}

// parseSnapshot builds a Snapshot from the JSON columns of the load statement (egress.rule_sets and egress.rules as
// jsonb arrays). A row that fails the shape checks is counted and skipped, not fatal: one bad hand edit must not stop
// the proxy from enforcing the rest.
func parseSnapshot(revision int64, setsJSON, rulesJSON []byte) (*Snapshot, error) {
	var sets []setRow
	if err := json.Unmarshal(setsJSON, &sets); err != nil {
		return nil, fmt.Errorf("rule sets: %w", err)
	}
	var rows []ruleRow
	if err := json.Unmarshal(rulesJSON, &rows); err != nil {
		return nil, fmt.Errorf("rules: %w", err)
	}
	s := &Snapshot{Revision: revision}
	for _, r := range sets {
		s.RuleSets = append(s.RuleSets, RuleSet{Name: r.Name, AppliesToAll: r.AppliesToAll})
	}
	for _, row := range rows {
		rule, ok := ruleFromRow(row)
		if !ok {
			s.Invalid++
			continue
		}
		s.Rules = append(s.Rules, rule)
	}
	return s, nil
}

func ruleFromRow(row ruleRow) (Rule, bool) {
	r := Rule{
		ID: row.ID.String(), Effect: row.Effect, Host: row.Host, Ports: row.Ports,
		Route: Route(row.Route), Private: row.AllowsPrivate,
	}
	if row.RuleSet != nil {
		r.RuleSet = *row.RuleSet
	}
	if row.SessionID != nil {
		r.SessionID = strings.ToLower(*row.SessionID)
	}
	if row.ExpiresAt != nil {
		t, err := time.Parse(time.RFC3339Nano, *row.ExpiresAt)
		if err != nil {
			return Rule{}, false
		}
		r.ExpiresAt = &t
	}
	return r, validRule(r)
}

// validRule repeats the cheap shape rules of validateEgressRule (session-core). Stored rows pass it unless someone
// edited the table by hand.
func validRule(r Rule) bool {
	if r.ID == "" || (r.RuleSet == "") == (r.SessionID == "") {
		return false
	}
	if r.Effect != "allow" && r.Effect != "deny" {
		return false
	}
	if r.Route != RouteDirect && r.Route != RouteOneCLI {
		return false
	}
	if len(r.Ports) < 1 || len(r.Ports) > 32 {
		return false
	}
	for _, p := range r.Ports {
		if p < 1 || p > 65535 {
			return false
		}
	}
	if r.Effect == "deny" && r.Route != RouteDirect {
		return false
	}
	if r.Host == anyHost {
		return r.Route == RouteDirect && !r.Private
	}
	if strings.Contains(r.Host, "/") {
		p, err := netip.ParsePrefix(r.Host)
		return err == nil && r.Private && p.Masked() == p && r.Effect == "allow" && r.Route == RouteDirect
	}
	if r.Private && (r.Effect != "allow" || r.Route != RouteDirect || strings.HasPrefix(r.Host, ".")) {
		return false
	}
	return dnsNameError(strings.TrimPrefix(r.Host, ".")) == ""
}
