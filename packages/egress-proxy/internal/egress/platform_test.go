package egress

import (
	"context"
	"errors"
	"net/netip"
	"sync"
	"testing"
)

type mapResolver struct {
	mu   sync.Mutex
	data map[string][]netip.Addr
}

func (r *mapResolver) LookupNetIP(_ context.Context, _, host string) ([]netip.Addr, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if a, ok := r.data[host]; ok {
		return append([]netip.Addr(nil), a...), nil
	}
	return nil, errors.New("no such host")
}

func TestPlatformBlocksResolvedHostsLiteralsAndCidrs(t *testing.T) {
	t.Parallel()
	res := &mapResolver{data: map[string][]netip.Addr{
		"pi-postgres.pi.svc": {netip.MustParseAddr("10.96.1.5")},
		"pi-ingest.pi.svc":   {netip.MustParseAddr("::ffff:10.96.1.6")},
	}}
	p := &Platform{
		Hosts:    []string{"pi-postgres.pi.svc", "pi-ingest.pi.svc", "10.96.0.1"},
		Prefixes: []netip.Prefix{netip.MustParsePrefix("172.18.0.0/24")},
		Resolver: res,
	}
	if err := p.Refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	for _, a := range []string{"10.96.1.5", "10.96.1.6", "10.96.0.1", "172.18.0.7", "::ffff:10.96.1.5"} {
		if _, ok := p.Blocks(netip.MustParseAddr(a)); !ok {
			t.Errorf("%s is not blocked", a)
		}
	}
	for _, a := range []string{"10.96.1.7", "8.8.8.8", "172.18.1.1"} {
		if _, ok := p.Blocks(netip.MustParseAddr(a)); ok {
			t.Errorf("%s is blocked", a)
		}
	}
}

func TestPlatformKeepsLastAddressesAndReportsNeverResolved(t *testing.T) {
	t.Parallel()
	res := &mapResolver{data: map[string][]netip.Addr{"pi-postgres.pi.svc": {netip.MustParseAddr("10.96.1.5")}}}
	p := &Platform{Hosts: []string{"pi-postgres.pi.svc", "missing.pi.svc"}, Resolver: res}
	if err := p.Refresh(context.Background()); err == nil {
		t.Fatal("a host that never resolved did not fail the refresh")
	}
	res.mu.Lock()
	res.data = map[string][]netip.Addr{} // DNS fails now
	res.mu.Unlock()
	_ = p.Refresh(context.Background())
	if _, ok := p.Blocks(netip.MustParseAddr("10.96.1.5")); !ok {
		t.Error("the last known address was dropped when DNS failed")
	}
}

func TestNewPlatformNeedsSomething(t *testing.T) {
	t.Parallel()
	if _, err := NewPlatform(nil, nil, nil, 0); err == nil {
		t.Error("an empty platform block list was accepted")
	}
}
