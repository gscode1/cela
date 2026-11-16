## Findings
### 1. Oversized request bodies reset the connection instead of returning an error
- Severity: low
- Confidence: high
- Location: packages/session-core/src/http.ts:25
- What happens: When a request body exceeds the limit, throwing inside the stream’s async iterator destroys the request stream and its underlying connection. The ingest handlers catch the `BodyError` and attempt to send a 400 response, but the client can receive a connection reset instead.
- Evidence: `if (size > limit) throw new BodyError("body too large");`
- Fix idea: Stop reading without destroying the request before the response is sent, and explicitly handle the remaining body or close the connection after returning the error.

END-OF-REPORT
