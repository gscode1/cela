// Command egress-proxy serves the session egress proxy. Configuration comes
// from the environment; secrets (admin token, policy file contents) are never logged.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
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
	policyFile := os.Getenv("EGRESS_POLICY_FILE")
	upstream := os.Getenv("EGRESS_UPSTREAM_ADDR")
	adminToken := os.Getenv("EGRESS_ADMIN_TOKEN")
	if policyFile == "" || upstream == "" || adminToken == "" {
		return errors.New("EGRESS_POLICY_FILE, EGRESS_UPSTREAM_ADDR and EGRESS_ADMIN_TOKEN are required")
	}
	maxAge, err := durationEnv("EGRESS_MAX_TUNNEL_AGE", time.Hour)
	if err != nil {
		return err
	}
	idle, err := durationEnv("EGRESS_IDLE_TIMEOUT", 10*time.Minute)
	if err != nil {
		return err
	}
	static, err := egress.LoadStatic(policyFile)
	if err != nil {
		return fmt.Errorf("policy file: %w", err)
	}
	log := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	p, err := egress.Build(egress.Options{
		Principals:   static,
		Policy:       static,
		UpstreamAddr: upstream,
		MaxTunnelAge: maxAge,
		IdleTimeout:  idle,
		Log:          log,
		Tweak: func(c *smokescreen.Config) {
			if err := c.InitializeSelfConnectionDetection(); err != nil {
				log.Warn("self-connection detection unavailable", "err", err)
			}
		},
	})
	if err != nil {
		return err
	}

	proxySrv := &http.Server{Addr: envOr("EGRESS_LISTEN", ":3128"), Handler: p.Handler(), ReadHeaderTimeout: 30 * time.Second}
	adminSrv := &http.Server{
		Addr:              envOr("EGRESS_ADMIN_LISTEN", "127.0.0.1:3129"),
		Handler:           egress.AdminHandler(p.Registry, adminToken),
		ReadHeaderTimeout: 10 * time.Second,
	}
	errc := make(chan error, 2)
	for _, s := range []*http.Server{proxySrv, adminSrv} {
		ln, err := net.Listen("tcp", s.Addr)
		if err != nil {
			return err
		}
		go func() { errc <- s.Serve(ln) }()
	}
	log.Info("listening", "proxy", proxySrv.Addr, "admin", adminSrv.Addr, "upstream", upstream)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
	}
	sctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = adminSrv.Shutdown(sctx)
	return proxySrv.Shutdown(sctx)
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
