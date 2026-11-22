package egress

import (
	"fmt"
	"net/netip"
	"time"
)

// SnapshotSource gives the snapshot to judge with, or false when there is none that can be trusted (a Loader).
type SnapshotSource interface {
	Current() (*Snapshot, bool)
}

// Rules is the Authorizer of the proxy: the rules in Postgres (through a SnapshotSource), the platform block list on
// top. With no fresh snapshot it denies everything.
type Rules struct {
	Source   SnapshotSource
	Platform *Platform
	// Now is the clock for rule expiry (time.Now in production).
	Now func() time.Time
}

// Authorize implements Authorizer. The order is: no usable snapshot, deny; an address of the platform, deny; then the
// evaluator (always-blocked addresses, deny rules, the most specific allow, private tier).
func (r *Rules) Authorize(p Principal, host string, port int, addrs []string) Decision {
	snap, ok := r.Source.Current()
	if !ok {
		return Decision{Kind: KindStale, Reason: "the egress rules are not available (no recent successful read from the database); everything is denied"}
	}
	if r.Platform != nil {
		for _, text := range addrs {
			a, ok := parseAddr(text)
			if !ok {
				continue
			}
			for _, x := range append([]netip.Addr{a}, embeddedIPv4(a)...) {
				if _, blocked := r.Platform.Blocks(x); blocked {
					return Decision{Kind: KindAlwaysBlocked, Reason: fmt.Sprintf("%s:%d is denied: it resolves to %s, an address of the platform itself (the cluster's own services, the database or the Kubernetes API) that no rule can allow", normalizeHost(host), port, text)}
				}
			}
		}
	}
	now := time.Now
	if r.Now != nil {
		now = r.Now
	}
	return Evaluate(snap.RuleSets, snap.Rules, Request{
		Host: host, Port: port, SessionID: p.Session, ProfileRuleSets: p.RuleSets, Addresses: addrs, Now: now(),
	})
}

// addrStrings is the text form the evaluator takes.
func addrStrings(list []netip.Addr) []string {
	out := make([]string, len(list))
	for i, a := range list {
		out[i] = a.String()
	}
	return out
}
