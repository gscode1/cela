package egress

import (
	"net"
	"sync"
	"testing"
	"time"
)

// Tracking, closing and revalidating at once must not race, and no connection may stay open with a live timer once it
// has been closed.
func TestRegistryTrackRacesRevalidate(t *testing.T) {
	r := NewRegistry(time.Hour)
	var wg sync.WaitGroup
	conns := make(chan net.Conn, 200)
	for i := 0; i < 200; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			a, b := net.Pipe()
			defer b.Close()
			tc := r.Track(tunnelInfo{session: "s"}, a)
			conns <- tc
			_ = tc.Close()
		}()
		wg.Add(1)
		go func() {
			defer wg.Done()
			r.Revalidate(func(tunnelInfo) string { return "test" })
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
		r.Track(tunnelInfo{session: "s"}, a)
	}
	deadline := time.Now().Add(ioWait)
	for r.Open("s") != 0 {
		if time.Now().After(deadline) {
			t.Fatalf("open = %d, want 0", r.Open("s"))
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestRegistryRevalidateClosesOnlyWhatJudgeDenies(t *testing.T) {
	r := NewRegistry(time.Hour)
	mk := func(session, host string) (*trackedConn, net.Conn) {
		a, b := net.Pipe()
		return r.Track(tunnelInfo{session: session, host: host}, a), b
	}
	keep, kb := mk("a", "ok.example.com")
	drop, db := mk("a", "bad.example.com")
	defer kb.Close()
	defer db.Close()
	out := r.Revalidate(func(i tunnelInfo) string {
		if i.host == "bad.example.com" {
			return "rule-denied"
		}
		return ""
	})
	if len(out) != 1 || out[0].host != "bad.example.com" || out[0].reason != "rule-denied" {
		t.Fatalf("revoked %+v", out)
	}
	if keep.closed.Load() || !drop.closed.Load() {
		t.Fatalf("keep closed=%v drop closed=%v", keep.closed.Load(), drop.closed.Load())
	}
	if r.Open("a") != 1 || r.Revoked() != 1 {
		t.Fatalf("open=%d revoked=%d", r.Open("a"), r.Revoked())
	}
	// A tunnel that ended on its own is not counted as revoked.
	_ = keep.Close()
	if out := r.Revalidate(func(tunnelInfo) string { return "x" }); len(out) != 0 || r.Revoked() != 1 {
		t.Fatalf("a closed tunnel was revoked again: %+v", out)
	}
}
