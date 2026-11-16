## Findings

### 1. Unknown grant categories are silently ignored
- Severity: high
- Confidence: high
- Location: packages/orchestrator/src/onecli-admin.ts:97
- What happens: If OneCLI returns a recognized `secrets` list alongside a new or otherwise unrecognized grant category, `parseGrants` ignores the latter. The caller can then conclude that an agent has only its two session secrets and hand out its token while the agent still has additional access.
- Evidence: The parser iterates only over `secrets`, `connections`, `apps`, and `appConnections`, then returns if any one was present: `if (!known) throw ...; return grants;`.
- Fix idea: Reject unrecognized grant-bearing fields, or validate the complete response against a known schema before treating it as proof that the agent is narrow.

### 2. Malformed successful responses can leak agent tokens through errors
- Severity: high
- Confidence: high
- Location: packages/orchestrator/src/onecli-admin.ts:149
- What happens: If a successful `GET /v1/agents` response contains malformed JSON, the `JSON.parse` exception can include a fragment of the response containing an agent access token. Callers log error messages, exposing the token in logs.
- Evidence: `body: text === "" ? undefined : (JSON.parse(text) as unknown)`
- Fix idea: Catch JSON parsing errors and throw a sanitized error containing only the method, path, and status, without the parser’s original message.

### 3. Accepted 404 responses can still break idempotent deletion
- Severity: medium
- Confidence: high
- Location: packages/orchestrator/src/onecli-admin.ts:145
- What happens: A delete request for an already-absent agent or secret accepts HTTP 404, but a nonempty plain-text or HTML 404 body is passed to `JSON.parse` and throws. Teardown then fails instead of continuing to revoke the remaining objects.
- Evidence: `deleteAgent` accepts `[200, 204, 404]`, but `#call` only skips body parsing for status 204.
- Fix idea: Ignore response bodies for deletion calls, or explicitly skip parsing for accepted 404 responses.

END-OF-REPORT
