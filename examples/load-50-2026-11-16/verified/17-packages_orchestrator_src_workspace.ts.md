### 1. Filesystem errors are treated as a lost workspace
- Verdict: CONFIRMED
- Severity (verified): medium
- Location (verified): packages/orchestrator/src/workspace.ts:64-67, 129-135
- Duplicate of: none
- Reasoning: `ExecutionEnv.exists` returns `Result<boolean, FileError>`; `isTrue` maps `ok:false` to false. For a session with `wasReady`, any error on either `exists` call (bridge/Pod hiccup right after the successful writeCa calls) gives `!hasMarker || !hasRepo` and throws WorkspaceLostError, which sessions.ts `#prepareRepo` turns into `#failSession` plus PermanentError: the session is failed for good on a transient error. For a not-yet-ready session an error instead leads to a needless clone attempt. Probability is low (needs an error on that call only), impact is permanent.

### 2. A failed system CA read silently removes public trust roots
- Verdict: PLAUSIBLE
- Severity (verified): low
- Location (verified): packages/orchestrator/src/workspace.ts:82-83
- Duplicate of: none
- Reasoning: `system.ok ? ... : ca` silently writes a bundle with only the OneCLI CA. SSL_CERT_FILE/GIT_SSL_CAINFO point at it, so tunnelled (non-injected) hosts with public certificates fail verification; `#prepared` then suppresses a rewrite until the orchestrator restarts. The trigger (an unreadable /etc/ssl/certs/ca-certificates.crt) is either a missing file in the image (deterministic, not transient) or a rare I/O error; git to github.com goes through injection and still works with only the OneCLI CA.
