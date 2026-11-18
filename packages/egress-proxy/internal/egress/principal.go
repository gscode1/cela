package egress

// AnonymousRole is the Smokescreen role (and tunnel-registry key) of a request that carries no principal. Slice 3 has
// no per-session tokens, so every request is anonymous: it is judged with no session and no profile, which leaves only
// the rule sets that apply to all. A real session id is a UUID, so the two cannot collide.
const AnonymousRole = "anonymous"

// Principal is who is asking. The zero value is anonymous.
type Principal struct {
	// Session is the session id; empty for an anonymous request. Its own rules apply.
	Session string
	// RuleSets are the rule sets its profile names (the sets that apply to all are added by the evaluator).
	RuleSets []string
	// OneCLIToken is the session's OneCLI agent token (slice 5); it never reaches the sandbox.
	OneCLIToken string
}

// Principals maps an egress token (the secret a sandbox holds) to a Principal. Slice 4 implements it over Postgres.
// Build with a nil Principals serves everyone anonymously, which is what slice 3 does.
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
