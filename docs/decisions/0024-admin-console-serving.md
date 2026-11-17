# 0024: How ingest serves the admin console

Status: accepted, 2026-11-17 (issue #143, admin UI slice 1). Implements the "Stack and delivery" and "Admin credentials and
login" sections of the [admin UI plan](../admin-ui-plan.md). The number skips 0023, which another change reserved.

## Context

The console is a static single-page app. It must be reachable by an operator without a token for the page itself, hold the
operator's token safely, and never be a way to run script from API content. Ingest already authenticates and authorises
`/admin/*` and is the only process the operator can reach.

## Decision

- **Ingest serves the bundle.** `packages/ingest/src/console.ts` answers `GET` and `HEAD` for `/console` and `/console/*`
  before the schema check and the bearer gate, from the directory `PI_CONSOLE_DIR` (the chart sets `/app/console` when
  `console.enabled` is true; the image always contains the build). No variable, no console: every console path is `404`.
  A separate web server would add a Deployment, a Service and a second place that needs access control.
- **Navigation fallback only for routes.** A path under `/console/` with a file extension is an asset and is `404` when
  missing; any other path gets `index.html`. Paths with `..`, NUL or backslash (also percent-encoded) are `404`.
- **Headers on console and `/admin/*`.** `Cache-Control: no-store`, `Content-Security-Policy: default-src 'self';
  frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`. They are set before the
  `401` and `403` answers too, so an error response is as hardened as a success. Other routes are unchanged: the session
  API is JSON for programs. The CSP allows no inline script or style; the Vite and Tailwind build emits files only, and the
  browser suite fails on a CSP violation.
- **The token lives in memory only.** The sign-in screen keeps it in React state, sends it as `Authorization: Bearer` with
  `credentials: "omit"` to the same origin, and verifies it with `GET /admin/settings` (`401` invalid token, `403` valid
  owner without admin access). Sign-out clears the token, the TanStack Query cache and the in-memory drafts. A reload asks
  again. Nothing is written to `localStorage`, `sessionStorage` or cookies, and API content is rendered as text.
- **No `dangerouslySetInnerHTML`.** Every value from the API is a React text node.
- **The browser suite runs on the operator machine.** `tests/e2e/run.sh console` installs the chart with the console on, and
  drives Playwright through a `kubectl port-forward` to `pi-ingest`, then upgrades the release with `console.enabled=false` and
  checks for `404`. The Job-based suites cannot host a browser, and a port-forward is the supported way to open the console.
  Playwright is not in `pnpm check`. The same specs run locally against the real ingest code over a stub pool
  (`pnpm --filter @pi-durable-k8s/admin-ui e2e:local`).
- **One admin in the e2e run.** The plan asks for two admins and one non-admin. `hack/gen-api-secret.sh` creates `alice` and
  `bob`, and the run's `api.admins` is `alice`; a second admin exercises nothing slice 1 has (the console shows no owner,
  because the API does not tell a caller its own name). It can come with the first screen that shows an actor.

## Consequences

- The ingest image grows by the bundle (about 100 KiB gzipped) and its build needs the console build in the same stage.
- Failed sign-ins are not rate-limited by ingest; the access advice in the chart README puts that on the ingress.
- The console and its API come from the same image, so a reload after an upgrade is enough; there is no contract version.
