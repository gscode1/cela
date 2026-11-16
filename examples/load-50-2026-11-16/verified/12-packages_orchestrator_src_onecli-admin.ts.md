### 1. Unknown grant categories are silently ignored
- Verdict: PLAUSIBLE
- Severity (verified): medium
- Location (verified): packages/orchestrator/src/onecli-admin.ts:97-110
- Duplicate of: none
- Reasoning: In the object form the loop only reads secrets/connections/apps/appConnections and `known` is set if any one is present, so an extra key (e.g. a new grant kind) is dropped and `#narrow` in repo-access.ts:210-213 would count only the known ones, treating the agent as narrow. The array form, by contrast, throws on unknown kinds, so the object form is inconsistent with the stated fail-closed contract. The trigger needs OneCLI to add a grant category the parser does not know (the code itself flags the shape as UNVERIFIED), so not shown to happen today. "High" is overstated.

### 2. Malformed successful responses can leak agent tokens through errors
- Verdict: PLAUSIBLE
- Severity (verified): low
- Location (verified): packages/orchestrator/src/onecli-admin.ts:149
- Duplicate of: none
- Reasoning: `JSON.parse(text)` on a 200 body that is invalid throws a SyntaxError whose Node message embeds a snippet of the input; callers log `errorMessage(error)` (inbox.ts:122 `inbox-drain-failed`, 209 stored in inbox.events.error, sweeper). For `GET /v1/agents` the body contains `accessToken` values, so a truncated or corrupt response could echo a fragment. V8's snippet is short and a 200 with malformed JSON from a healthy gateway is unlikely, so the leak is partial and improbable. The project rule "never print secret values" makes the sanitisation worthwhile though.

### 3. Accepted 404 responses can still break idempotent deletion
- Verdict: PLAUSIBLE
- Severity (verified): low
- Location (verified): packages/orchestrator/src/onecli-admin.ts:145-150
- Duplicate of: none
- Reasoning: `deleteAgent`/`deleteSecret`/`revokeGrant` accept 404, but only 204 skips body parsing; a 404 with a non-JSON body (HTML from a proxy or framework default) makes `JSON.parse` throw a SyntaxError (not an OneCliError, so repo-access.ts:#revoke's `error.status === 404` catch for secrets does not apply). Teardown then fails and is retried forever by the delete backoff (ADR 0006), because the stored id keeps returning the same 404. Requires a non-JSON 404 from OneCLI, which is not evidenced in the repo.
