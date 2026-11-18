package egress

// SnapshotPrincipals is the Principals of the proxy: the live principals of the current rules snapshot (ADR 0036).
// A token is looked up by its sha256, so the snapshot holds no token. With no usable snapshot nobody is known and every
// authenticated request is refused (the rules would not be available either).
type SnapshotPrincipals struct {
	Source SnapshotSource
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

// OneCLIToken implements Principals: there is none before slice 5.
func (SnapshotPrincipals) OneCLIToken(string) (string, bool) { return "", false }
