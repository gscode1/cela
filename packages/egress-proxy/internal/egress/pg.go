package egress

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// RulesChannel is the NOTIFY channel the admin API signals on after every write (session-core EGRESS_RULES_CHANNEL).
const RulesChannel = "egress_rules"

// DBTLS is the TLS setting towards Postgres, the same three modes as the app's database.tls: "" or "disable" leaves
// the connection URI's own sslmode in charge, verify-ca checks the chain only, verify-full also checks the host name.
type DBTLS struct {
	Mode     string
	CAFile   string // PEM bundle; empty uses the system roots
	CertFile string // optional client certificate and key
	KeyFile  string
}

func (t DBTLS) config(serverName string) (*tls.Config, error) {
	switch t.Mode {
	case "", "disable":
		return nil, nil
	case "verify-ca", "verify-full":
	default:
		return nil, fmt.Errorf("database tls mode %q is not disable, verify-ca or verify-full", t.Mode)
	}
	pool, err := x509.SystemCertPool()
	if err != nil || pool == nil {
		pool = x509.NewCertPool()
	}
	if t.CAFile != "" {
		pem, err := os.ReadFile(t.CAFile)
		if err != nil {
			return nil, err
		}
		pool = x509.NewCertPool()
		if !pool.AppendCertsFromPEM(pem) {
			return nil, errors.New("database tls: no certificate in the CA file")
		}
	}
	c := &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}
	if t.CertFile != "" || t.KeyFile != "" {
		cert, err := tls.LoadX509KeyPair(t.CertFile, t.KeyFile)
		if err != nil {
			return nil, err
		}
		c.Certificates = []tls.Certificate{cert}
	}
	if t.Mode == "verify-full" {
		c.ServerName = serverName
		return c, nil
	}
	// verify-ca: the chain must verify, the name need not match.
	c.InsecureSkipVerify = true //nolint:gosec // the chain is verified below
	c.VerifyConnection = func(cs tls.ConnectionState) error {
		opts := x509.VerifyOptions{Roots: pool, Intermediates: x509.NewCertPool()}
		for _, ic := range cs.PeerCertificates[1:] {
			opts.Intermediates.AddCert(ic)
		}
		_, err := cs.PeerCertificates[0].Verify(opts)
		return err
	}
	return c, nil
}

// DB is the proxy's connection to Postgres: a small pool for reads and status writes, and a dedicated connection for
// LISTEN. The role behind the URI can read the egress rule tables and write egress.proxy_status, nothing else.
type DB struct {
	Pool *pgxpool.Pool
	conn *pgx.ConnConfig
	// Host is the database host of the URI, for the platform block list.
	Host string
}

// OpenDB parses the URI and prepares the pool; it does not connect (the loader retries, and the proxy is not ready
// until the first read worked).
func OpenDB(ctx context.Context, uri string, t DBTLS) (*DB, error) {
	cfg, err := pgxpool.ParseConfig(uri)
	if err != nil {
		// pgx error text can quote parts of the URI; say nothing of it.
		return nil, errors.New("the database URI cannot be parsed")
	}
	cfg.MaxConns = 3
	cfg.ConnConfig.ConnectTimeout = 3 * time.Second
	cfg.ConnConfig.RuntimeParams["application_name"] = "egress-proxy"
	cfg.ConnConfig.RuntimeParams["statement_timeout"] = "4000"
	tc, err := t.config(cfg.ConnConfig.Host)
	if err != nil {
		return nil, err
	}
	if tc != nil {
		cfg.ConnConfig.TLSConfig = tc
		cfg.ConnConfig.Fallbacks = nil // never fall back to plaintext
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, errors.New("cannot create the database pool")
	}
	return &DB{Pool: pool, conn: cfg.ConnConfig.Copy(), Host: cfg.ConnConfig.Host}, nil
}

// Close releases the pool.
func (d *DB) Close() { d.Pool.Close() }

const loadSQL = `select (select coalesce(max(revision), 0) from egress.revisions) as revision,
       (select coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb) from egress.rule_sets s) as rule_sets,
       (select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) from egress.rules r) as rules`

// Fetch reads the revision, the rule sets and the rules in one statement, so one snapshot.
func (d *DB) Fetch(ctx context.Context) (*Snapshot, error) {
	var revision int64
	var sets, rules []byte
	if err := d.Pool.QueryRow(ctx, loadSQL).Scan(&revision, &sets, &rules); err != nil {
		return nil, scrub(err)
	}
	return parseSnapshot(revision, sets, rules)
}

// scrub keeps an error useful without echoing connection details: the server's message and code, or the error kind.
func scrub(err error) error {
	var pe *pgconn.PgError
	if errors.As(err, &pe) {
		return fmt.Errorf("postgres: %s (%s)", pe.Message, pe.Code)
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return errors.New("postgres: timed out")
	}
	return errors.New("postgres: " + errKind(err))
}

func errKind(err error) string {
	var ne interface{ Timeout() bool }
	if errors.As(err, &ne) && ne.Timeout() {
		return "timed out"
	}
	return "connection failed"
}

// Listen runs until ctx ends: it holds a connection that LISTENs on RulesChannel and calls onNotify for every
// notification, and once after every (re)connect (a notification may have been missed meanwhile). A broken connection
// is retried with a pause; the loader's poll covers the gap.
func (d *DB) Listen(ctx context.Context, log *slog.Logger, onNotify func()) {
	pause := time.Second
	for ctx.Err() == nil {
		err := d.listenOnce(ctx, onNotify)
		if ctx.Err() != nil {
			return
		}
		if log != nil {
			log.Warn("egress rules listener stopped, retrying", "err", scrub(err).Error())
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(pause):
		}
		if pause < 10*time.Second {
			pause *= 2
		}
	}
}

func (d *DB) listenOnce(ctx context.Context, onNotify func()) error {
	conn, err := pgx.ConnectConfig(ctx, d.conn)
	if err != nil {
		return err
	}
	defer func() {
		cctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = conn.Close(cctx)
	}()
	if _, err := conn.Exec(ctx, "listen "+RulesChannel); err != nil {
		return err
	}
	onNotify()
	for {
		if _, err := conn.WaitForNotification(ctx); err != nil {
			return err
		}
		onNotify()
	}
}
