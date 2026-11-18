# 0026: Optional HTTPRoute and Ingress for ingest

Status: accepted, 2026-11-18 (issue #166). Amends [ADR 0024](0024-admin-console-serving.md), which said the chart ships no
Ingress.

## Context

The admin console and the session API are served by ingest on port 8080. Until now the chart rendered no route, so an
operator on a LAN either used `kubectl port-forward` or wrote an HTTPRoute by hand next to the release, as on the c2 lab
cluster. A hand-made route is not upgraded or removed with the release, and it is easy to forget the second half:
`default-deny-all` drops the gateway's traffic unless `networkPolicy.ingest.clients` admits it.

## Decision

- **Two optional routes, both off by default.** `ingest.httpRoute` renders a Gateway API `HTTPRoute` (`parentRefs`,
  `hostnames`, `paths`, `annotations`); `ingest.ingress` renders a `networking.k8s.io/v1` `Ingress` (`className`, `hosts`,
  `paths`, `tls`, `annotations`). Both point at the `pi-ingest` Service, port 8080, and may be on together. The chart
  does not render a Gateway, TLS certificates or controller-specific policies: those belong to the cluster.
- **`paths` are prefixes, default `["/"]`.** That serves the session API, `/admin` and the console. `["/console", "/admin"]`
  serves only the operator screens, for a route that operators alone can reach.
- **The session stream has no total timeout (issue #172).** `GET /sessions/{id}/stream` is server-sent events for as
  long as a client watches, and a session may run for days. A gateway default request timeout (Envoy Gateway: 15 s) cut
  it, so the HTTPRoute renders a `RegularExpression` rule for the stream path with `timeouts.request` from
  `ingest.httpRoute.timeouts.stream` (default `0s`, no limit) before the prefix rule, whose timeout is
  `timeouts.request` (default: the gateway's). Envoy Gateway orders a regular-expression match before a prefix match;
  checked on c2. The keepalive every 15 s keeps the gateway's idle timeout from closing a live stream, and a client
  that loses the stream resumes with `Last-Event-ID`. The Ingress gets no timeout fields: controllers set them by
  annotation.
- **No route without an admitted client.** The chart refuses to render while a route is on and
  `networkPolicy.ingest.clients` is empty. The chart cannot know the gateway's pod labels, so the operator names them;
  `values.yaml` shows the Envoy Gateway selector.
- **Schema checks.** An enabled HTTPRoute needs at least one `parentRef`, an enabled Ingress at least one host, and every
  path starts with `/`.

## Consequences

- Ingest still does not rate-limit failed sign-ins (ADR 0024). A route reachable by untrusted clients needs rate limiting
  or an authenticating proxy on the gateway; the chart README says so.
- The `HTTPRoute` needs the Gateway API CRDs in the cluster; with the route off nothing changes for clusters without them.
