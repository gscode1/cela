// Command egress-proxy serves the session egress proxy. Configuration comes from the environment; secrets (the
// database URI) are never logged. It reads the egress rules from Postgres (ADR 0035) and serves
// nothing until the first read has worked.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"os"
	"os/signal"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/gscode1/pi-durable-k8s/egress-proxy/internal/egress"
	"github.com/stripe/smokescreen/v2/pkg/smokescreen"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "egress-proxy:", err)
		os.Exit(1)
	}
}

func run() error {
	// goproxy reads these and would silently send route=direct tunnels (or skip
	// the upstream, with NO_PROXY) through another proxy. Fail closed.
	for _, k := range []string{"HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"} {
		if os.Getenv(k) != "" {
			return fmt.Errorf("%s must not be set", k)
		}
	}
	dbURI := os.Getenv("EGRESS_DATABASE_URL")
	if dbURI == "" {
		return errors.New("EGRESS_DATABASE_URL is required")
	}
	maxAge, err := durationEnv("EGRESS_MAX_TUNNEL_AGE", time.Hour)
	if err != nil {
		return err
	}
	idle, err := durationEnv("EGRESS_IDLE_TIMEOUT", 10*time.Minute)
	if err != nil {
		return err
	}
	poll, err := durationEnv("EGRESS_POLL", 5*time.Second)
	if err != nil {
		return err
	}
	staleAfter, err := durationEnv("EGRESS_STALE_AFTER", 2*time.Minute)
	if err != nil {
		return err
	}
	prefixes, err := parsePrefixes(os.Getenv("EGRESS_PLATFORM_CIDRS"))
	if err != nil {
		return err
	}
	log := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	db, err := egress.OpenDB(ctx, dbURI, egress.DBTLS{
		Mode:     os.Getenv("PI_DURABLE_DATABASE_TLS_MODE"),
		CAFile:   os.Getenv("PI_DURABLE_DATABASE_TLS_CA_FILE"),
		CertFile: os.Getenv("PI_DURABLE_DATABASE_TLS_CERT_FILE"),
		KeyFile:  os.Getenv("PI_DURABLE_DATABASE_TLS_KEY_FILE"),
	})
	if err != nil {
		return err
	}
	defer db.Close()

	// The platform's own addresses: the chart's service names, the database host of this very connection and the
	// Kubernetes API's ClusterIP (set in every pod's environment), plus the operator's cidrs.
	hosts := splitList(os.Getenv("EGRESS_PLATFORM_HOSTS"))
	hosts = append(hosts, db.Host)
	if h := os.Getenv("KUBERNETES_SERVICE_HOST"); h != "" {
		hosts = append(hosts, h)
	}
	platform, err := egress.NewPlatform(dedupe(hosts), prefixes, &net.Resolver{}, 30*time.Second)
	if err != nil {
		return err
	}

	loader := &egress.Loader{Fetch: db.Fetch, Poll: poll, StaleAfter: staleAfter, Log: log}
	replica := envOr("POD_NAME", hostname())
	reporter := &egress.StatusReporter{DB: db, Loader: loader, Replica: replica, Version: envOr("EGRESS_VERSION", "dev"), Log: log}

	// Probes first, so a pod that cannot reach its database is visibly not ready instead of crash-looping.
	var ready atomic.Bool
	health := &http.Server{Addr: envOr("EGRESS_HEALTH_LISTEN", ":3130"), Handler: healthHandler(&ready), ReadHeaderTimeout: 10 * time.Second}
	errc := make(chan error, 4)
	serve(health, errc)

	go loader.Run(ctx)
	go db.Listen(ctx, log, loader.Nudge)
	go reporter.Run(ctx)

	// Not serving before the first successful read of the rules and of the platform addresses.
	select {
	case <-loader.Ready():
	case err := <-errc:
		return err
	case <-ctx.Done():
		return nil
	}
	for {
		perr := platform.Refresh(ctx)
		if perr == nil {
			break
		}
		log.Warn("waiting for the platform addresses", "err", perr.Error())
		select {
		case <-time.After(2 * time.Second):
		case <-ctx.Done():
			return nil
		}
	}
	go platform.Run(ctx, func(err error) { log.Warn("platform addresses not refreshed", "err", err.Error()) })

	// The key that opens the OneCLI tokens in egress.bindings (ADR 0037), read from a mounted file, never from the
	// environment. The route needs both the upstream address and the key.
	upstream := os.Getenv("EGRESS_UPSTREAM_ADDR")
	var bindingKey []byte
	if f := os.Getenv("EGRESS_BINDING_KEY_FILE"); f != "" {
		raw, err := os.ReadFile(f)
		if err != nil {
			return errors.New("EGRESS_BINDING_KEY_FILE: cannot read the file")
		}
		if bindingKey, err = egress.ParseBindingKey(string(raw)); err != nil {
			return fmt.Errorf("EGRESS_BINDING_KEY_FILE: %w", err)
		}
	}
	if (upstream == "") != (bindingKey == nil) {
		return errors.New("EGRESS_UPSTREAM_ADDR and EGRESS_BINDING_KEY_FILE must be set together")
	}
	rules := &egress.Rules{Source: loader, Platform: platform}
	p, err := egress.Build(egress.Options{
		Authorizer: rules,
		// The sandboxes' egress tokens, from the same snapshot as the rules (ADR 0036). A request with no token is
		// anonymous unless EGRESS_REQUIRE_AUTH is true; a token that is unknown, revoked or used from another Pod is 407.
		Principals:        egress.SnapshotPrincipals{Source: loader, BindingKey: bindingKey},
		RequireAuth:       os.Getenv("EGRESS_REQUIRE_AUTH") == "true",
		OpenPrivateRanges: true,
		UpstreamAddr:      upstream, // the OneCLI gateway; empty: onecli matches are denied
		MaxTunnelAge:      maxAge,
		IdleTimeout:       idle,
		Log:               log,
		Tweak: func(c *smokescreen.Config) {
			if err := c.InitializeSelfConnectionDetection(); err != nil {
				log.Warn("self-connection detection unavailable", "err", err)
			}
		},
	})
	if err != nil {
		return err
	}

	// Open tunnels follow the rules: every successful read re-judges them (ADR 0039), and a snapshot gone stale closes
	// them all. EGRESS_MAX_TUNNEL_AGE stays as the backstop. Subscribed before the first tunnel can exist.
	loader.Subscribe(func() { p.Sweep() }, func() {
		if n := p.CloseAll("stale"); n > 0 {
			log.Warn("egress rules stale, open tunnels closed", "closed", n)
		}
	})
	proxySrv := &http.Server{Addr: envOr("EGRESS_LISTEN", ":3128"), Handler: p.Handler(), ReadHeaderTimeout: 30 * time.Second}
	servers := []*http.Server{proxySrv, health}
	serve(proxySrv, errc)
	ready.Store(true)
	log.Info("listening", "proxy", proxySrv.Addr, "replica", replica, "staleAfter", staleAfter.String(), "maxTunnelAge", maxAge.String())

	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
	}
	ready.Store(false)
	sctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for _, s := range servers {
		_ = s.Shutdown(sctx)
	}
	return nil
}

func serve(s *http.Server, errc chan<- error) {
	ln, err := net.Listen("tcp", s.Addr)
	if err != nil {
		errc <- err
		return
	}
	go func() {
		if err := s.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errc <- err
		}
	}()
}

// healthHandler: /healthz says the process runs; /readyz says the first rules were read and the proxy listens. A proxy
// whose rules went stale stays ready on purpose: it answers every request with a deny that says why, instead of
// refusing the connection.
func healthHandler(ready *atomic.Bool) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	mux.HandleFunc("/readyz", func(w http.ResponseWriter, _ *http.Request) {
		if ready.Load() {
			w.WriteHeader(http.StatusOK)
			return
		}
		http.Error(w, "starting", http.StatusServiceUnavailable)
	})
	return mux
}

func hostname() string {
	h, err := os.Hostname()
	if err != nil || h == "" {
		return "egress-proxy"
	}
	return h
}

func splitList(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func dedupe(in []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, s := range in {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}

func parsePrefixes(s string) ([]netip.Prefix, error) {
	var out []netip.Prefix
	for _, p := range splitList(s) {
		pre, err := netip.ParsePrefix(p)
		if err != nil {
			// A bare address is a /32 (or /128).
			a, aerr := netip.ParseAddr(p)
			if aerr != nil {
				return nil, fmt.Errorf("EGRESS_PLATFORM_CIDRS: %q is not a cidr or an address", p)
			}
			pre = netip.PrefixFrom(a.Unmap(), a.Unmap().BitLen())
		}
		out = append(out, pre.Masked())
	}
	return out, nil
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func durationEnv(k string, def time.Duration) (time.Duration, error) {
	v := os.Getenv(k)
	if v == "" {
		return def, nil
	}
	d, err := time.ParseDuration(v)
	if err != nil || d <= 0 {
		return 0, fmt.Errorf("%s: want a positive duration like 30m", k)
	}
	return d, nil
}
