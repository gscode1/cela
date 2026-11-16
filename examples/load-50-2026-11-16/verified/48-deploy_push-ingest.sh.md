### 1. Deployment lookup errors are reported as a successful push
- Verdict: CONFIRMED
- Severity (verified): low
- Location (verified): deploy/push-ingest.sh:32
- Duplicate of: none
- Reasoning: `if k get deployment pi-ingest >/dev/null 2>&1; then` treats any failure (RBAC denial, API timeout, wrong context) as "no deployment", skips `rollout restart` and prints "ingest bundle pushed". Worse, the ConfigMap annotation `bundle-sha256` was already applied at line 31, so a re-run hits "ingest bundle unchanged" (line 26) and exits without ever restarting, leaving pods on old code until someone restarts them manually. Needs a transient or permission failure on `get deployment` right after a successful `apply`, so it is unlikely.

### 2. Archive timestamps cause unchanged code to trigger rollouts
- Verdict: CONFIRMED
- Severity (verified): low
- Location (verified): deploy/push-ingest.sh:15-17,24-26
- Duplicate of: none
- Reasoning: The ingest build script is `rm -rf dist && tsc -p tsconfig.build.json`, so every run recreates `dist/*` with new mtimes; `pnpm deploy` copies them and `tar -czf` stores mtimes (no `--mtime`/sort normalisation), so the sha256 differs run to run and the "unchanged" short-circuit at line 26 effectively never fires. Consequence is only a needless ConfigMap update and rollout restart.
