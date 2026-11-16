package egress

import (
	"net"
	"sync"
	"sync/atomic"
	"time"
)

// Registry tracks the upstream connection of every open tunnel by session, so
// that a session's tunnels can be closed on demand and no tunnel outlives
// maxAge. Closing the upstream side ends the tunnel: goproxy then closes the
// client side.
type Registry struct {
	maxAge time.Duration
	mu     sync.Mutex
	conns  map[string]map[*trackedConn]struct{}
}

func NewRegistry(maxAge time.Duration) *Registry {
	return &Registry{maxAge: maxAge, conns: map[string]map[*trackedConn]struct{}{}}
}

// Track registers c under session and returns the wrapper to use in its place.
func (r *Registry) Track(session string, c net.Conn) net.Conn {
	t := &trackedConn{Conn: c, session: session, reg: r}
	// The timer is installed before t is published, under t.mu, so a
	// concurrent CloseSession (or a very short timer) either sees it and
	// stops it or runs after it is set.
	t.mu.Lock()
	if r.maxAge > 0 {
		t.timer = time.AfterFunc(r.maxAge, func() { _ = t.Close() })
	}
	t.mu.Unlock()
	r.mu.Lock()
	// Close sets closed before it takes r.mu to remove t, so a t that was
	// already closed (a very short max age) is never published and leaked.
	if !t.closed.Load() {
		set := r.conns[session]
		if set == nil {
			set = map[*trackedConn]struct{}{}
			r.conns[session] = set
		}
		set[t] = struct{}{}
	}
	r.mu.Unlock()
	return t
}

// CloseSession closes every open tunnel of the session and returns how many.
func (r *Registry) CloseSession(session string) int {
	r.mu.Lock()
	set := r.conns[session]
	conns := make([]*trackedConn, 0, len(set))
	for c := range set {
		conns = append(conns, c)
	}
	r.mu.Unlock()
	for _, c := range conns {
		_ = c.Close()
	}
	return len(conns)
}

// Open returns the number of open tunnels of the session.
func (r *Registry) Open(session string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.conns[session])
}

func (r *Registry) remove(t *trackedConn) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if set := r.conns[t.session]; set != nil {
		delete(set, t)
		if len(set) == 0 {
			delete(r.conns, t.session)
		}
	}
}

type trackedConn struct {
	net.Conn
	session string
	reg     *Registry
	mu      sync.Mutex // guards timer
	timer   *time.Timer
	closed  atomic.Bool
	once    sync.Once
	err     error
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
