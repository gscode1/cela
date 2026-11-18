package egress

import "strings"

// SnapshotPrincipals is the Principals of the proxy: the live principals of the current rules snapshot (ADR 0036).
// A token is looked up by its sha256, so the snapshot holds no token. With no usable snapshot nobody is known and every
// authenticated request is refused (the rules would not be available either).
type SnapshotPrincipals struct {
	Source SnapshotSource
	// BindingKey opens the sealed OneCLI tokens of the snapshot (ADR 0037). Nil: no session has a binding, so the onecli
	// route is denied for everyone.
	BindingKey []byte
}

// Lookup implements Principals.
func (s SnapshotPrincipals) Lookup(egressToken string) (Principal, bool) {
	snap, ok := s.Source.Current()
	if !ok || egressToken == "" {
		return Principal{}, false
	}
	p, ok := snap.byHash[HashToken(egressToken)]
	return p, ok
}

// BySession implements Principals.
func (s SnapshotPrincipals) BySession(session string) (Principal, bool) {
	snap, ok := s.Source.Current()
	if !ok {
		return Principal{}, false
	}
	p, ok := snap.bySession[session]
	return p, ok
}

// OneCLIToken implements Principals: the session's OneCLI agent token, opened from its binding. A session without a
// binding, a binding sealed with another key or one that fails authentication has none, and the onecli route is denied.
func (s SnapshotPrincipals) OneCLIToken(session string) (string, bool) {
	snap, ok := s.Source.Current()
	if !ok || s.BindingKey == nil {
		return "", false
	}
	session = strings.ToLower(session)
	b, ok := snap.bindings[session]
	if !ok || b.keyID != BindingKeyID(s.BindingKey) {
		return "", false
	}
	tok, err := OpenBinding(s.BindingKey, session, b.nonce, b.ciphertext)
	if err != nil {
		return "", false
	}
	return tok, true
}
