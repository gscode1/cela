### 1. Validation accepts trailing line terminators
- Verdict: REJECTED
- Severity (verified): n/a
- Location (verified): packages/session-core/src/repo.ts:11-12
- Duplicate of: none
- Reasoning: In JavaScript, without the `m` flag `$` matches only at the very end of input, not before a trailing newline (that is PCRE/Python behaviour). Verified with node: `/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test("octo/hello\n")` is false and `REF.test("main\n")` is false.
### 2. Branch validation misses `.lock` in intermediate components
- Verdict: CONFIRMED
- Severity (verified): low
- Location (verified): packages/session-core/src/repo.ts:38
- Duplicate of: none
- Reasoning: `branch.endsWith(".lock")` only checks the final component; `feature.lock/foo` matches REF and none of the other checks, so `chooseRepo` returns it and POST /sessions returns 201, while git refuses a ref component ending in `.lock`, so the clone fails later. Only a self-inflicted failure for the caller's own session; no security impact (`/.` and `..` are already rejected).
