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
			tc := r.Track("s", a)
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
		r.Track("s", a)
	}
	deadline := time.Now().Add(ioWait)
	for r.Open("s") != 0 {
		if time.Now().After(deadline) {
			t.Fatalf("open = %d, want 0", r.Open("s"))
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// A dial whose ACL decision predates CloseSession registers afterwards; the
// connection must be closed at once, until the session is granted again.
func TestRegistryTrackAfterCloseSessionIsClosed(t *testing.T) {
	r := NewRegistry(time.Hour)
	r.CloseSession("s")
	a, b := net.Pipe()
	defer b.Close()
	tc := r.Track("s", a)
	if !tc.(*trackedConn).closed.Load() {
		t.Fatal("connection tracked after revocation is still open")
	}
	if n := r.Open("s"); n != 0 {
		t.Fatalf("open = %d, want 0", n)
	}
	// Other sessions are unaffected.
	c, d := net.Pipe()
	defer d.Close()
	if r.Track("other", c).(*trackedConn).closed.Load() {
		t.Fatal("other session was revoked")
	}

	r.Grant("s")
	e, f := net.Pipe()
	defer f.Close()
	if r.Track("s", e).(*trackedConn).closed.Load() {
		t.Fatal("connection closed after the session was granted again")
	}
}
