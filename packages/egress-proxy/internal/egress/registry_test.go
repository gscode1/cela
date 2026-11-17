package egress

import (
	"net"
	"sync"
	"testing"
	"time"
)

// Tracking connections while CloseSession runs must not race, and no
// connection may stay open with a live timer once it has been closed.
func TestRegistryTrackRacesCloseSession(t *testing.T) {
	r := NewRegistry(time.Hour)
	var wg sync.WaitGroup
	conns := make(chan net.Conn, 200)
	for i := 0; i < 200; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			a, b := net.Pipe()
			defer b.Close()
			tc := r.Track("s", time.Now(), a)
			conns <- tc
			_ = tc.Close()
		}()
		wg.Add(1)
		go func() {
			defer wg.Done()
			r.CloseSession("s")
		}()
	}
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(ioWait):
		t.Fatal("timed out")
	}
	close(conns)
	for c := range conns {
		tc := c.(*trackedConn)
		tc.mu.Lock()
		timer := tc.timer
		tc.mu.Unlock()
		if timer == nil || timer.Stop() {
			t.Fatal("timer of a closed connection is still pending")
		}
	}
	if n := r.Open("s"); n != 0 {
		t.Fatalf("open = %d, want 0", n)
	}
}

// A very short max age fires the timer concurrently with Track returning.
func TestRegistryTimerFiresDuringTrack(t *testing.T) {
	r := NewRegistry(time.Nanosecond)
	for i := 0; i < 200; i++ {
		a, b := net.Pipe()
		defer b.Close()
		r.Track("s", time.Now(), a)
	}
	deadline := time.Now().Add(ioWait)
	for r.Open("s") != 0 {
		if time.Now().After(deadline) {
			t.Fatalf("open = %d, want 0", r.Open("s"))
		}
		time.Sleep(5 * time.Millisecond)
	}
}

type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fakeClock) now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *fakeClock) advance(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

func newClockRegistry() (*Registry, *fakeClock) {
	clk := &fakeClock{t: time.Unix(1000, 0)}
	r := NewRegistry(time.Hour)
	r.now = clk.now
	r.horizon = time.Minute
	return r, clk
}

func closedAfterTrack(r *Registry, session string, at time.Time) bool {
	a, b := net.Pipe()
	defer b.Close()
	return r.Track(session, at, a).(*trackedConn).closed.Load()
}

// A dial authorized before CloseSession is closed when it reaches Track, even
// if another request was authorized in between; one authorized after works.
func TestRegistryDialAuthorizedBeforeCloseIsClosed(t *testing.T) {
	r, clk := newClockRegistry()
	before := clk.now()
	clk.advance(time.Second)
	r.CloseSession("s")
	clk.advance(time.Second)
	between := clk.now() // another request authorized after the close
	clk.advance(time.Second)

	if !closedAfterTrack(r, "s", before) {
		t.Fatal("dial authorized before the close survived")
	}
	if closedAfterTrack(r, "s", between) {
		t.Fatal("request authorized after the close was revoked")
	}
	// The later request must not undo the revocation of the earlier dial.
	if !closedAfterTrack(r, "s", before) {
		t.Fatal("a later authorization undid the revocation")
	}
	if closedAfterTrack(r, "other", before) {
		t.Fatal("other session was revoked")
	}
}

func TestRegistryPrunesRevocationsAfterHorizon(t *testing.T) {
	r, clk := newClockRegistry()
	r.CloseSession("old")
	clk.advance(2 * time.Minute)
	r.CloseSession("new")
	r.mu.Lock()
	_, oldKept := r.revokedAt["old"]
	_, newKept := r.revokedAt["new"]
	r.mu.Unlock()
	if oldKept || !newKept {
		t.Fatalf("after CloseSession: old kept=%v new kept=%v", oldKept, newKept)
	}
	clk.advance(2 * time.Minute)
	closedAfterTrack(r, "x", clk.now()) // Track prunes too
	r.mu.Lock()
	n := len(r.revokedAt)
	r.mu.Unlock()
	if n != 0 {
		t.Fatalf("revokedAt has %d entries after the horizon", n)
	}
}
