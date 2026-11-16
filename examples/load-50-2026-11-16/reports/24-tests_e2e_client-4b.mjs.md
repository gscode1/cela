## Findings

### 1. Token parsing rejects valid server configurations
- Severity: medium
- Confidence: high
- Location: tests/e2e/client-4b.mjs:15
- What happens: The server accepts comma-separated token entries and tokens containing colons. This client splits only on newlines and truncates tokens at the first colon, so a valid configuration can cause authentication failures or a “no token” error.
- Evidence: `split("\n")` followed by `line.trim().split(":")`
- Fix idea: Split entries on newlines or commas, then split each entry only at its first colon, matching the server’s parser.

### 2. Answer check can pass before the tool runs
- Severity: medium
- Confidence: high
- Location: tests/e2e/client-4b.mjs:101
- What happens: If an assistant message contains both a tool call and the expected text, the client counts that call before checking the text and reports success. The real-model test can therefore pass without an answer produced after the tool executed.
- Evidence: `calls += (message.calls ?? []).length;` precedes the `calls > 0` text check.
- Fix idea: Require the matching text to occur in a later assistant message after a tool result, rather than counting calls in the same message.

END-OF-REPORT
