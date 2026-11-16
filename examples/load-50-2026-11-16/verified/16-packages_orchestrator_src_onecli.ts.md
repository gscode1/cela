### 1. IPv6 NO_PROXY entries do not match IPv6 hosts
- Verdict: CONFIRMED
- Severity (verified): low
- Location (verified): packages/orchestrator/src/onecli.ts:118-121 (with 102)
- Duplicate of: none
- Reasoning: `splitPort("::1")` matches `/^(.*):(\d+)$/` as pattern ":" port "1", so it never equals host "::1" (brackets stripped at line 102) and the port check also fails; `[::1]:8080` yields pattern "[::1]" which keeps brackets and never matches the stripped host. Only affects models served from an IPv6 literal in NO_PROXY, an unusual configuration; the default NO_PROXY in the sandbox env is separate code.

### 2. Redirects do not re-evaluate NO_PROXY
- Verdict: PLAUSIBLE
- Severity (verified): low
- Location (verified): packages/orchestrator/src/onecli.ts:162-168
- Duplicate of: none
- Reasoning: The bypass decision is made once on the input URL; fetch follows redirects inside whichever implementation was chosen (default `redirect: "follow"`), so a cross-routing redirect keeps the original routing. Model provider APIs essentially never redirect between a NO_PROXY host and a proxied host, so no realistic trigger exists in this deployment.
