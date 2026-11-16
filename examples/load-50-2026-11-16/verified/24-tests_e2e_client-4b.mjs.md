### 1. Token parsing rejects valid server configurations
- Verdict: CONFIRMED
- Severity (verified): low
- Location (verified): tests/e2e/client-4b.mjs:15-16
- Duplicate of: none
- Reasoning: The server parser (packages/session-core/src/auth.ts:33-38) splits entries on `/[\n,]/` and takes everything after the first colon as the token; the client does `.split("\n")` and `const [name, token] = line.trim().split(":")`, so `alice:tok1,bob:tok2` on one line yields name `alice`, token `tok1,bob`, and a token containing `:` is truncated. Test helper only; the deployed secret apparently uses one entry per line, and tests/e2e/client.mjs:33 already uses the correct split.

### 2. Answer check can pass before the tool runs
- Verdict: PLAUSIBLE
- Severity (verified): low
- Location (verified): tests/e2e/client-4b.mjs:101-102
- Duplicate of: none
- Reasoning: `calls += (message.calls ?? []).length;` runs before the needle check on the same message, so an assistant message with a tool call and text containing the needle passes. The needle ("hello") is deliberately not in the user prompt (`printf "hel%s" lo`, and calls are recorded as `name(args)`), so it only matches if the model writes the predicted output in the same message as the call, which is possible for a chatty real model but not the normal pattern (the answer follows the tool result in a later message).
