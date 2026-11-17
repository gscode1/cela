## Findings

### 1. Deployment lookup errors are reported as a successful push
- Severity: medium
- Confidence: high
- Location: deploy/push-ingest.sh:32
- What happens: If the ConfigMap update succeeds but the deployment lookup fails because of an API error or insufficient permissions, the script skips the restart and prints success. Existing pods continue running the old code because they unpack the bundle only at startup.
- Evidence: `if k get deployment pi-ingest >/dev/null 2>&1; then`
- Fix idea: Distinguish a genuinely absent deployment from other lookup failures, and fail the script for errors that prevent the required restart.

### 2. Archive timestamps cause unchanged code to trigger rollouts
- Severity: low
- Confidence: high
- Location: deploy/push-ingest.sh:17
- What happens: Each invocation rebuilds the packages, recreating their `dist` files with new timestamps. The archive includes those timestamps, so its hash can change even when the code has not, causing unnecessary ConfigMap updates and pod rollouts.
- Evidence: `tar --no-xattrs -czf "$work/app.tgz" -C "$work/app" .`
- Fix idea: Create a reproducible archive with normalized timestamps, ownership, and ordering before calculating its hash.

END-OF-REPORT
