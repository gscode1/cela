## Findings

### 1. Interrupted swap can leave the orchestrator without code
- Severity: high
- Confidence: high
- Location: deploy/retired-orchestrator-delivery:74
- What happens: If the loader is killed or the second rename fails after `/code/app` is moved aside, the exit trap restarts the deployment with no `/code/app`. A subsequent push also deletes `/code/app.old` before installing the replacement, losing the previous working copy.
- Evidence: `mv /code/app /code/app.old` followed by `mv /code/app.new /code/app`
- Fix idea: Recover any interrupted swap before deleting the backup, and restore the old tree if installation fails. Use an atomic pointer switch between versioned directories to avoid a missing live path.

### 2. Concurrent pushes interfere with each other
- Severity: high
- Confidence: high
- Location: deploy/retired-orchestrator-delivery:21
- What happens: Two pushes share the same loader pod and staging paths. Either invocation can delete the other’s loader, including when its own build fails before creating a pod; its cleanup can also scale the deployment back up while the other push is still writing.
- Evidence: `k delete pod retired-code-volume-loader --ignore-not-found --wait=false` runs unconditionally in the exit trap.
- Fix idea: Serialize pushes with a cluster-scoped lock for the PVC. Make cleanup delete only resources owned by the current invocation.

### 3. Pod deletion wait failures are ignored
- Severity: medium
- Confidence: high
- Location: deploy/retired-orchestrator-delivery:40
- What happens: If an orchestrator pod takes more than 120 seconds to terminate, or the wait fails for another reason, the script proceeds anyway. The loader can then modify the code volume while the old orchestrator is still running on the same node, or fail to mount it on another node.
- Evidence: `k wait --for=delete pod ... --timeout=120s >/dev/null 2>&1 || true`
- Fix idea: Treat failure to confirm pod deletion as a deployment failure and let cleanup restore the deployment without writing the volume.

END-OF-REPORT
