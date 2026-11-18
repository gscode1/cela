package egress

import (
	"context"
	"log/slog"
	"sync"
	"time"
)

// Loader keeps the latest Snapshot. It reads on a poll and when told to (a LISTEN notification), and says the
// snapshot is unusable once nothing has been read successfully for StaleAfter: then Current reports false and the
// proxy denies everything. Nothing is served before the first successful read (Ready).
type Loader struct {
	// Fetch reads one snapshot (one statement, one revision).
	Fetch func(ctx context.Context) (*Snapshot, error)
	// Poll is how often to read without a notification; StaleAfter how long without a success is too long.
	Poll       time.Duration
	StaleAfter time.Duration
	// FetchTimeout bounds one read, so a dead database fails fast and the poll goes on.
	FetchTimeout time.Duration
	Log          *slog.Logger
	// Now is the clock (time.Now in production); tests move it.
	Now func() time.Time

	mu      sync.RWMutex
	snap    *Snapshot
	lastOK  time.Time
	lastErr error
	ready   chan struct{}
	once    sync.Once
	nudge   chan struct{}
}

func (l *Loader) init() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.ready == nil {
		l.ready = make(chan struct{})
		l.nudge = make(chan struct{}, 1)
	}
	if l.Now == nil {
		l.Now = time.Now
	}
	if l.Poll <= 0 {
		l.Poll = 5 * time.Second
	}
	if l.StaleAfter <= 0 {
		l.StaleAfter = 2 * time.Minute
	}
	if l.FetchTimeout <= 0 {
		l.FetchTimeout = 4 * time.Second
	}
}

// Ready is closed after the first successful read.
func (l *Loader) Ready() <-chan struct{} {
	l.init()
	return l.ready
}

// Nudge asks for a read soon (a notification arrived). It never blocks.
func (l *Loader) Nudge() {
	l.init()
	select {
	case l.nudge <- struct{}{}:
	default:
	}
}

// Current is the snapshot to judge with, and false when there is none or it is stale: the caller denies everything.
func (l *Loader) Current() (*Snapshot, bool) {
	l.init()
	l.mu.RLock()
	defer l.mu.RUnlock()
	if l.snap == nil || l.Now().Sub(l.lastOK) > l.StaleAfter {
		return nil, false
	}
	return l.snap, true
}

// State is what the status row says: starting (no snapshot yet), serving, or stale (too old, everything denied).
func (l *Loader) State() (state string, revision *int64, lastRead *time.Time) {
	l.init()
	l.mu.RLock()
	defer l.mu.RUnlock()
	if l.snap == nil {
		return "starting", nil, nil
	}
	rev, at := l.snap.Revision, l.lastOK
	if l.Now().Sub(l.lastOK) > l.StaleAfter {
		return "stale", &rev, &at
	}
	return "serving", &rev, &at
}

// LastError is the error of the latest failed read, nil after a success.
func (l *Loader) LastError() error {
	l.mu.RLock()
	defer l.mu.RUnlock()
	return l.lastErr
}

// Refresh reads once and swaps the snapshot in on success.
func (l *Loader) Refresh(ctx context.Context) error {
	l.init()
	fctx, cancel := context.WithTimeout(ctx, l.FetchTimeout)
	defer cancel()
	snap, err := l.Fetch(fctx)
	l.mu.Lock()
	defer l.mu.Unlock()
	if err != nil {
		l.lastErr = err
		return err
	}
	prev := l.snap
	l.snap, l.lastOK, l.lastErr = snap, l.Now(), nil
	l.once.Do(func() { close(l.ready) })
	if l.Log != nil && (prev == nil || prev.Revision != snap.Revision) {
		l.Log.Info("egress rules loaded", "revision", snap.Revision, "ruleSets", len(snap.RuleSets), "rules", len(snap.Rules), "invalid", snap.Invalid)
	}
	return nil
}

// Run reads until ctx ends: at once, on every poll tick and on every Nudge. A failure is logged and retried at the next
// tick; the snapshot in use stays until it goes stale.
func (l *Loader) Run(ctx context.Context) {
	l.init()
	t := time.NewTicker(l.Poll)
	defer t.Stop()
	for {
		if err := l.Refresh(ctx); err != nil && ctx.Err() == nil && l.Log != nil {
			l.Log.Warn("egress rules read failed", "err", err.Error())
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		case <-l.nudge:
		}
	}
}
