### 1. Interrupted swap can leave the orchestrator without code
- Verdict: PLAUSIBLE
- Severity (verified): low
- Location (verified): deploy/push-code.sh:74-76
- Duplicate of: none
- Reasoning: Lines 74/75 are two renames; if the exec is killed between them (or the second fails) `/code/app` is absent while `app.old` holds the old tree, and the trap still scales to 1, so the pod crash-loops. The window is microseconds and a same-directory rename practically does not fail. The "next push deletes app.old" part is harmless because the next push installs a fresh `/code/app` anyway (line 70 then 75); it only loses the backup if the next push also fails.
### 2. Concurrent pushes interfere with each other
- Verdict: CONFIRMED
- Severity (verified): medium
- Location (verified): deploy/push-code.sh:21,43,65-76
- Duplicate of: none
- Reasoning: The loader pod name and /code/app.new paths are fixed, and `cleanup` runs `k delete pod orchestrator-code-loader --ignore-not-found --wait=false` on every exit, including when this run never created a loader (e.g. the pnpm build at line 28 fails). Run B's cleanup (or its line 43 delete) kills run A's loader mid-copy, and B's trap scales the deployment back to 1 (it is in B's `scaled` since the deployment exists) while A still writes. Needs two simultaneous pushes, plausible given the one-worktree-per-change workflow; no lock exists.
### 3. Pod deletion wait failures are ignored
- Verdict: PLAUSIBLE
- Severity (verified): low
- Location (verified): deploy/push-code.sh:40
- Duplicate of: none
- Reasoning: `|| true` does swallow a timeout or kubectl error. But orchestrator.yaml sets no terminationGracePeriodSeconds (default 30s), so the 120s wait only expires if the pod is stuck Terminating (e.g. unreachable node), in which case the RWO volume stays attached and the loader fails its `wait --for=condition=Ready` (line 65, 240s) and the script fails and restores. The same-node overlap only affects a dying orchestrator that does not write the code volume.
