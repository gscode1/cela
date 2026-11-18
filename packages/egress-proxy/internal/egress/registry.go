package egress

import (
	"net"
	"sync"
	"sync/atomic"
	"time"
)

// tunnelInfo is what a tunnel was decided on. The registry keeps it so a later snapshot can be asked the same
// question again: would the new rules still let this session open this tunnel?
type tunnelInfo struct {
	session string
	host    string // normalized destination name (the origin's, also for route=onecli)
	port    int
	addrs   []string // the addresses the decision checked; the direct route dialled the first
	route   Route
	// upstreamKey is a hash of the OneCLI token the tunnel was opened with (route=onecli only). The token itself is
	// never kept. A rotated binding changes it, and the tunnel is closed so the next connection uses the new token.
	upstreamKey [32]byte
}

// revoked is a tunnel the registry closed on a re-evaluation, with the reason (rule-denied, principal-revoked,
// route-changed, binding-removed, binding-changed or stale).
type revoked struct {
	tunnelInfo
	reason string
}

// Registry tracks the upstream connection of every open tunnel, with the inputs of its decision, so that tunnels the
// current rules would no longer allow can be closed, and so that no tunnel outlives maxAge (the backstop for anything
// the re-evaluation misses). Closing the upstream side ends the tunnel: goproxy then closes the client side.
type Registry struct {
	maxAge  time.Duration
	mu      sync.Mutex
	conns   map[string]map[*trackedConn]struct{}
	revoked atomic.Int64
}

func NewRegistry(maxAge time.Duration) *Registry {
	return &Registry{maxAge: maxAge, conns: map[string]map[*trackedConn]struct{}{}}
}

// Track registers c with the inputs of its decision and returns the wrapper to use in its place. The caller re-judges
// the tunnel after Track (Proxy.dial): a snapshot that arrived between the decision and now has swept before the
// tunnel was registered and cannot have closed it, while one that arrives after is swept with the tunnel in place.
func (r *Registry) Track(info tunnelInfo, c net.Conn) *trackedConn {
	t := &trackedConn{Conn: c, info: info, reg: r}
	// The timer is installed before t is published, under t.mu, so a concurrent Close (or a very short timer) either
	// sees it and stops it or runs after it is set.
	t.mu.Lock()
	if r.maxAge > 0 {
		t.timer = time.AfterFunc(r.maxAge, func() { _ = t.Close() })
	}
	t.mu.Unlock()
	r.mu.Lock()
	// Close sets closed before it takes r.mu to remove t, so a t that was already closed (a very short max age) is
	// never published and leaked.
	if !t.closed.Load() {
		set := r.conns[info.session]
		if set == nil {
			set = map[*trackedConn]struct{}{}
			r.conns[info.session] = set
		}
		set[t] = struct{}{}
	}
	r.mu.Unlock()
	return t
}

// Revalidate asks judge about every open tunnel and closes those it gives a reason for. It returns what it closed.
// judge runs outside the registry lock (it reads the snapshot), on a copy of the tunnel list.
func (r *Registry) Revalidate(judge func(tunnelInfo) string) []revoked {
	r.mu.Lock()
	var all []*trackedConn
	for _, set := range r.conns {
		for c := range set {
			all = append(all, c)
		}
	}
	r.mu.Unlock()
	var out []revoked
	for _, c := range all {
		if reason := judge(c.info); reason != "" {
			if c.closeRevoked() {
				out = append(out, revoked{c.info, reason})
			}
		}
	}
	return out
}

// Open returns the number of open tunnels of the session.
func (r *Registry) Open(session string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.conns[session])
}

// Total returns the number of open tunnels.
func (r *Registry) Total() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := 0
	for _, set := range r.conns {
		n += len(set)
	}
	return n
}

// Revoked is how many tunnels the registry has closed on a re-evaluation since it started.
func (r *Registry) Revoked() int64 { return r.revoked.Load() }

func (r *Registry) remove(t *trackedConn) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if set := r.conns[t.info.session]; set != nil {
		delete(set, t)
		if len(set) == 0 {
			delete(r.conns, t.info.session)
		}
	}
}

type trackedConn struct {
	net.Conn
	info    tunnelInfo
	reg     *Registry
	mu      sync.Mutex // guards timer
	timer   *time.Timer
	closed  atomic.Bool
	revoked atomic.Bool
	once    sync.Once
	err     error
}

// closeRevoked closes the tunnel and says whether this call was the one that ended it (a tunnel that already ended on
// its own is not counted as revoked).
func (t *trackedConn) closeRevoked() bool {
	if t.closed.Load() {
		return false
	}
	won := false
	if t.revoked.CompareAndSwap(false, true) {
		won = !t.closed.Load()
	}
	_ = t.Close()
	if won {
		t.reg.revoked.Add(1)
	}
	return won
}

func (t *trackedConn) Close() error {
	t.once.Do(func() {
		t.closed.Store(true)
		t.mu.Lock()
		if t.timer != nil {
			t.timer.Stop()
		}
		t.mu.Unlock()
		t.reg.remove(t)
		t.err = t.Conn.Close()
	})
	return t.err
}
