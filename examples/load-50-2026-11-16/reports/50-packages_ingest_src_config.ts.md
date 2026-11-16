## Findings
### 1. Empty port configuration binds an unpredictable port
- Severity: low
- Confidence: high
- Location: packages/ingest/src/config.ts:22
- What happens: If `PI_INGEST_PORT` is set to an empty or whitespace-only string, `Number()` converts it to `0`, which passes validation. The server then listens on an OS-assigned port rather than the configured service and probe port, making the pod unreachable.
- Evidence: `const port = Number(env.PI_INGEST_PORT ?? "8080");`
- Fix idea: Reject empty and whitespace-only values before numeric conversion, or treat them as absent and use the default.

### 2. Unsupported orchestrator URLs are accepted at startup
- Severity: low
- Confidence: high
- Location: packages/ingest/src/config.ts:29
- What happens: An empty, malformed, or HTTPS `PI_ORCH_URL` is accepted, so ingest can become ready while every stream request fails with a 500. The stream proxy uses `node:http` and cannot request an HTTPS URL.
- Evidence: `orchestratorUrl: env.PI_ORCH_URL ?? "http://pi-orchestrator:8081"`
- Fix idea: Validate the URL and its supported protocol during configuration loading. If HTTPS endpoints are intended to work, select the matching HTTP or HTTPS client in the proxy.

END-OF-REPORT
