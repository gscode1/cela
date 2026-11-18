package egress

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"sync"
	"time"
)

// Platform is the set of addresses that belong to the platform itself and that no rule can open: the pi-durable
// namespace's Services (the database, the orchestrators, ingest, the OneCLI API) and the Kubernetes API. It is not
// something the rules or the private tier can express, because a private rule with a wide cidr (10.0.0.0/8) would
// otherwise reach them.
//
// The set comes from the chart's configuration, not from the Kubernetes API (the proxy has no API token):
//   - Hosts: names to resolve at start and every Interval (the Services, the database host from the proxy's own
//     connection URI, kubernetes.default.svc), and IP literals (KUBERNETES_SERVICE_HOST). A name that cannot be
//     resolved keeps its last addresses; one that never resolved keeps the proxy from becoming ready.
//   - Prefixes: cidrs the operator names for what DNS cannot say (the API server's own addresses, the namespace's pod
//     range, an external database).
type Platform struct {
	Hosts    []string
	Prefixes []netip.Prefix
	Resolver interface {
		LookupNetIP(ctx context.Context, network, host string) ([]netip.Addr, error)
	}
	Interval time.Duration

	mu    sync.RWMutex
	addrs map[string][]netip.Addr
}

// Refresh resolves every host once. It returns an error naming the hosts that have never resolved (the proxy is not
// ready until it returns nil once); a host that resolved before and fails now keeps its last addresses.
func (p *Platform) Refresh(ctx context.Context) error {
	next := map[string][]netip.Addr{}
	var failed []string
	for _, h := range p.Hosts {
		if a, err := netip.ParseAddr(h); err == nil {
			next[h] = []netip.Addr{a.Unmap()}
			continue
		}
		rctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		ips, err := p.Resolver.LookupNetIP(rctx, "ip", h)
		cancel()
		if err != nil || len(ips) == 0 {
			p.mu.RLock()
			old, had := p.addrs[h]
			p.mu.RUnlock()
			if had {
				next[h] = old
			} else {
				failed = append(failed, h)
			}
			continue
		}
		for i := range ips {
			ips[i] = ips[i].Unmap()
		}
		next[h] = ips
	}
	p.mu.Lock()
	p.addrs = next
	p.mu.Unlock()
	if len(failed) > 0 {
		return fmt.Errorf("platform hosts not resolved yet: %v", failed)
	}
	return nil
}

// Run refreshes every Interval until ctx ends. The caller has already made one successful Refresh.
func (p *Platform) Run(ctx context.Context, onError func(error)) {
	interval := p.Interval
	if interval <= 0 {
		interval = 30 * time.Second
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := p.Refresh(ctx); err != nil && onError != nil {
				onError(err)
			}
		}
	}
}

// Blocks reports whether a belongs to the platform, and which entry says so.
func (p *Platform) Blocks(a netip.Addr) (string, bool) {
	a = a.Unmap()
	for _, pre := range p.Prefixes {
		if pre.Contains(a) {
			return pre.String(), true
		}
	}
	p.mu.RLock()
	defer p.mu.RUnlock()
	for host, list := range p.addrs {
		for _, x := range list {
			if x == a {
				return host, true
			}
		}
	}
	return "", false
}

// NewPlatform checks the configuration; at least one host or prefix is needed, so a misconfiguration cannot mean "no
// platform block".
func NewPlatform(hosts []string, prefixes []netip.Prefix, resolver *net.Resolver, interval time.Duration) (*Platform, error) {
	if len(hosts) == 0 && len(prefixes) == 0 {
		return nil, errors.New("platform block list is empty")
	}
	return &Platform{Hosts: hosts, Prefixes: prefixes, Resolver: resolver, Interval: interval}, nil
}
