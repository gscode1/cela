package egress

import (
	"context"
	"log/slog"
	"time"
)

// StatusReporter writes this replica's row in egress.proxy_status every Interval, so GET /admin/egress/status can say
// which revision each replica serves and whether it is denying everything because its rules went stale. It also
// removes rows that have been silent for ten minutes (the pod names of earlier rollouts). A failure to write never
// affects serving: when the database is down the replica goes stale on its own and the admin API shows it silent.
type StatusReporter struct {
	DB       *DB
	Loader   *Loader
	Replica  string
	Version  string
	Interval time.Duration
	Log      *slog.Logger
	started  time.Time
}

const upsertSQL = `insert into egress.proxy_status (replica, revision, state, last_read_at, started_at, version, updated_at)
values ($1, $2, $3, $4, $5, $6, clock_timestamp())
on conflict (replica) do update set revision = excluded.revision, state = excluded.state,
  last_read_at = excluded.last_read_at, version = excluded.version, updated_at = clock_timestamp()`

// Report writes the row once.
func (s *StatusReporter) Report(ctx context.Context) error {
	if s.started.IsZero() {
		s.started = time.Now()
	}
	state, rev, last := s.Loader.State()
	if _, err := s.DB.Pool.Exec(ctx, upsertSQL, s.Replica, rev, state, last, s.started, s.Version); err != nil {
		return scrub(err)
	}
	_, err := s.DB.Pool.Exec(ctx, `delete from egress.proxy_status where updated_at < clock_timestamp() - interval '10 minutes'`)
	return scrub2(err)
}

func scrub2(err error) error {
	if err == nil {
		return nil
	}
	return scrub(err)
}

// Run reports until ctx ends, then removes the row (best effort).
func (s *StatusReporter) Run(ctx context.Context) {
	interval := s.Interval
	if interval <= 0 {
		interval = 5 * time.Second
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		rctx, cancel := context.WithTimeout(ctx, 4*time.Second)
		err := s.Report(rctx)
		cancel()
		if err != nil && ctx.Err() == nil && s.Log != nil {
			s.Log.Warn("egress proxy status not written", "err", err.Error())
		}
		select {
		case <-ctx.Done():
			dctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			_, _ = s.DB.Pool.Exec(dctx, `delete from egress.proxy_status where replica = $1`, s.Replica)
			cancel()
			return
		case <-t.C:
		}
	}
}
