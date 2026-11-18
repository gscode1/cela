package egress

import (
	"crypto/sha256"
	"encoding/hex"
	"net/netip"
)

// AnonymousRole is the Smokescreen role (and tunnel-registry key) of a request that carries no principal (no
// Proxy-Authorization at all, and the proxy does not require one): it is judged with no session and no profile, which
// leaves only the rule sets that apply to all. A real session id is a UUID, so the two cannot collide.
const AnonymousRole = "anonymous"

// Principal is who is asking. The zero value is anonymous.
type Principal struct {
	// Session is the session id; empty for an anonymous request. Its own rules apply.
	Session string
	// RuleSets are the rule sets its profile names (the sets that apply to all are added by the evaluator).
	RuleSets []string
	// PodIP is the address of the session's sandbox Pod; the token is accepted only from it. The zero Addr means the
	// orchestrator has not recorded one yet, and the token is then refused (ADR 0036).
	PodIP netip.Addr
	// OneCLIToken is the session's OneCLI agent token (slice 5); it never reaches the sandbox.
	OneCLIToken string
}

// HashToken is what the database stores of an egress token: lowercase hex of sha256 (session-core hashEgressToken).
func HashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// Principals maps an egress token (the secret a sandbox holds) to a Principal. SnapshotPrincipals implements it over the
// rules snapshot. Build with a nil Principals serves everyone anonymously (the tests of the tunnel code do).
type Principals interface {
	Lookup(egressToken string) (Principal, bool)
	// BySession returns the principal of a session id (the Smokescreen role of its tunnels).
	BySession(session string) (Principal, bool)
	// OneCLIToken returns the upstream token bound to a session, if any.
	OneCLIToken(session string) (string, bool)
}

// Authorizer decides whether a principal may connect to host:port and by which route. addrs are the addresses the
// host resolved to, as text; nil judges the name only. Deny by default.
type Authorizer interface {
	Authorize(p Principal, host string, port int, addrs []string) Decision
}
