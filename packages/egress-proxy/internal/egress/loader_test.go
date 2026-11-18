package egress

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

type stepClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *stepClock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *stepClock) advance(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

func TestLoaderFailsClosedAfterStaleAfter(t *testing.T) {
	t.Parallel()
	clock := &stepClock{t: time.Unix(1000, 0)}
	var mu sync.Mutex
	fail := false
	rev := int64(7)
	l := &Loader{
		Fetch: func(context.Context) (*Snapshot, error) {
			mu.Lock()
			defer mu.Unlock()
			if fail {
				return nil, errors.New("postgres: connection failed")
			}
			return &Snapshot{Revision: rev}, nil
		},
		StaleAfter: 2 * time.Minute,
		Now:        clock.now,
	}
	if _, ok := l.Current(); ok {
		t.Fatal("a snapshot before the first read")
	}
	if state, rev, _ := l.State(); state != "starting" || rev != nil {
		t.Fatalf("state %s %v, want starting", state, rev)
	}
	select {
	case <-l.Ready():
		t.Fatal("ready before the first read")
	default:
	}
	if err := l.Refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	select {
	case <-l.Ready():
	default:
		t.Fatal("not ready after the first read")
	}
	if s, ok := l.Current(); !ok || s.Revision != 7 {
		t.Fatalf("current %v %v", s, ok)
	}

	// The database goes away: the snapshot stays usable for two minutes, then everything is denied.
	mu.Lock()
	fail = true
	mu.Unlock()
	clock.advance(119 * time.Second)
	if err := l.Refresh(context.Background()); err == nil {
		t.Fatal("expected a failed read")
	}
	if _, ok := l.Current(); !ok {
		t.Fatal("denied before the stale limit")
	}
	clock.advance(2 * time.Second)
	if _, ok := l.Current(); ok {
		t.Fatal("still serving a snapshot older than the stale limit")
	}
	if state, rev, _ := l.State(); state != "stale" || rev == nil || *rev != 7 {
		t.Fatalf("state %s, want stale at revision 7", state)
	}

	// It comes back: a successful read serves again, at the new revision.
	mu.Lock()
	fail, rev = false, 9
	mu.Unlock()
	if err := l.Refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	if s, ok := l.Current(); !ok || s.Revision != 9 {
		t.Fatalf("current %v %v after recovery", s, ok)
	}
}

func TestLoaderRunReadsOnNudgeAndPoll(t *testing.T) {
	t.Parallel()
	var mu sync.Mutex
	reads := 0
	l := &Loader{
		Fetch: func(context.Context) (*Snapshot, error) {
			mu.Lock()
			defer mu.Unlock()
			reads++
			return &Snapshot{Revision: int64(reads)}, nil
		},
		Poll: time.Hour, // only a nudge can cause the second read
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	done := make(chan struct{})
	go func() { l.Run(ctx); close(done) }()
	<-l.Ready()
	l.Nudge()
	deadline := time.After(5 * time.Second)
	for {
		if s, ok := l.Current(); ok && s.Revision >= 2 {
			break
		}
		select {
		case <-deadline:
			t.Fatal("a nudge did not cause a read")
		case <-time.After(10 * time.Millisecond):
		}
	}
	cancel()
	<-done
}

func TestRefreshBoundsAHungRead(t *testing.T) {
	t.Parallel()
	l := &Loader{
		Fetch: func(ctx context.Context) (*Snapshot, error) {
			<-ctx.Done() // a database that accepts the connection and never answers
			return nil, ctx.Err()
		},
		FetchTimeout: 50 * time.Millisecond,
	}
	start := time.Now()
	if err := l.Refresh(context.Background()); err == nil {
		t.Fatal("expected an error")
	}
	if time.Since(start) > 5*time.Second {
		t.Fatal("a hung read was not bounded")
	}
}
