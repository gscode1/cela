### 1. Empty port configuration binds an unpredictable port
- Verdict: CONFIRMED
- Severity (verified): low
- Location (verified): packages/ingest/src/config.ts:22-23
- Duplicate of: none
- Reasoning: `??` only substitutes the default for undefined, so `PI_INGEST_PORT=""` gives `Number("")` = 0 (also `"  "`), which passes `port < 0 || port > 65535`; `server.listen(0)` then takes an ephemeral port and the probes/Service on 8080 fail. deploy/ingest.yaml sets a literal "8080", so it needs an edited manifest with an empty value; fails visibly (pod not ready).

### 2. Unsupported orchestrator URLs are accepted at startup
- Verdict: CONFIRMED
- Severity (verified): low
- Location (verified): packages/ingest/src/config.ts:29 (failure at packages/ingest/src/server.ts:272-286)
- Duplicate of: none
- Reasoning: `PI_ORCH_URL=""` is kept by `??`, and a garbage value is never parsed. In `proxyStream`, `new URL(path, "")` throws, and `httpRequest(new URL("https://..."))` throws ERR_INVALID_PROTOCOL synchronously; both are caught by createIngestServer (server.ts:42-44) and become 500s on every stream request while /readyz stays green. Only a misconfigured env triggers it.
