package egress

import (
	"encoding/hex"
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
	// byHash and bySession index the principals that are not revoked (a revoked or deleted one is not in the snapshot).
	byHash    map[string]Principal
	bySession map[string]Principal
	// bindings are the sealed OneCLI tokens by session id (ADR 0037). They stay sealed here: SnapshotPrincipals opens one
	// at the moment a tunnel needs it, so the snapshot holds no plaintext token.
	bindings map[string]sealedBinding
	// Invalid counts the stored rows that were left out because they do not pass the rule shape checks; the
	// admin API reports the same rows as invalid, and the evaluation of explain skips them too.
	Invalid int
	// InvalidPrincipals counts principal rows that could not be used.
	InvalidPrincipals int
	// InvalidBindings counts binding rows that could not be used (a malformed row).
	InvalidBindings int
}

type sealedBinding struct {
	keyID      string
	nonce      []byte
	ciphertext []byte
}

// bindingRow is one egress.bindings row as the load statement returns it (bytes as hex).
type bindingRow struct {
	SessionID  string `json:"session_id"`
	KeyID      string `json:"key_id"`
	Nonce      string `json:"nonce"`
	Ciphertext string `json:"ciphertext"`
}

// addBindings indexes the binding rows. A row that is malformed is counted and skipped: its session has no binding, which
// the proxy treats as a deny for the onecli route.
func (s *Snapshot) addBindings(rows []bindingRow) {
	s.bindings = make(map[string]sealedBinding, len(rows))
	for _, row := range rows {
		nonce, err1 := hex.DecodeString(row.Nonce)
		ct, err2 := hex.DecodeString(row.Ciphertext)
		if row.SessionID == "" || err1 != nil || err2 != nil || len(nonce) == 0 || len(ct) == 0 {
			s.InvalidBindings++
			continue
		}
		s.bindings[strings.ToLower(row.SessionID)] = sealedBinding{keyID: row.KeyID, nonce: nonce, ciphertext: ct}
	}
}

// Bindings is how many sessions have a binding in the snapshot.
func (s *Snapshot) Bindings() int { return len(s.bindings) }

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

// parseSnapshot builds a Snapshot from the JSON columns of the load statement (egress.rule_sets, egress.rules and the
// live egress.principals as jsonb arrays). A row that fails the shape checks is counted and skipped, not fatal: one bad hand edit must not stop
// the proxy from enforcing the rest.
type principalRow struct {
	SessionID string   `json:"session_id"`
	TokenHash string   `json:"token_hash"`
	RuleSets  []string `json:"rule_sets"`
	PodIP     *string  `json:"pod_ip"`
}

// addPrincipals indexes the principal rows. A row without a session id or with a hash that is not sha256 hex is skipped
// (and counted in InvalidPrincipals), as is an address that does not parse (the token is then refused, like an unknown one).
func (s *Snapshot) addPrincipals(rows []principalRow) {
	s.byHash = make(map[string]Principal, len(rows))
	s.bySession = make(map[string]Principal, len(rows))
	for _, row := range rows {
		if row.SessionID == "" || len(row.TokenHash) != 64 {
			s.InvalidPrincipals++
			continue
		}
		p := Principal{Session: strings.ToLower(row.SessionID), RuleSets: row.RuleSets}
		if row.PodIP != nil {
			if a, err := netip.ParseAddr(*row.PodIP); err == nil {
				p.PodIP = a.Unmap()
			}
		}
		s.byHash[row.TokenHash] = p
		s.bySession[p.Session] = p
	}
}

// Principals is how many principals the snapshot holds (not revoked).
func (s *Snapshot) Principals() int { return len(s.byHash) }

func parseSnapshot(revision int64, setsJSON, rulesJSON, principalsJSON, bindingsJSON []byte) (*Snapshot, error) {
	var sets []setRow
	if err := json.Unmarshal(setsJSON, &sets); err != nil {
		return nil, fmt.Errorf("rule sets: %w", err)
	}
	var rows []ruleRow
	if err := json.Unmarshal(rulesJSON, &rows); err != nil {
		return nil, fmt.Errorf("rules: %w", err)
	}
	var principals []principalRow
	if len(principalsJSON) > 0 {
		if err := json.Unmarshal(principalsJSON, &principals); err != nil {
			return nil, fmt.Errorf("principals: %w", err)
		}
	}
	var bindings []bindingRow
	if len(bindingsJSON) > 0 {
		if err := json.Unmarshal(bindingsJSON, &bindings); err != nil {
			return nil, fmt.Errorf("bindings: %w", err)
		}
	}
	s := &Snapshot{Revision: revision}
	s.addPrincipals(principals)
	s.addBindings(bindings)
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
