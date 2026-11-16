## Findings
### 1. Disabling the request timeout permits stalled uploads indefinitely
- Severity: medium
- Confidence: high
- Location: packages/ingest/src/main.ts:26
- What happens: A client with a valid token can open POST requests and leave their bodies incomplete indefinitely. Enough such requests can exhaust connections or memory and deny service to other clients. The body-size limit does not help when the client stays below it.
- Evidence: `server.requestTimeout = 0;`
- Fix idea: Keep a finite request-receive timeout. Node’s request timeout limits receipt of the request, not the lifetime of the SSE response, so long-lived streams do not require disabling it.

END-OF-REPORT
