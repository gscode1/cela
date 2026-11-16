### 1. Bridge can read the launcher's master key through `/proc`
- Verdict: PLAUSIBLE
- Severity (verified): medium
- Location (verified): packages/orchestrator/src/bridge-launcher.ts:72
- Duplicate of: none
- Reasoning: The mechanism is real: the launcher keeps its full initial environment (including PI_SANDBOX_MASTER_KEY) and spawns the bridge as the same uid (deploy/orchestrator.yaml runAsUser 1000, no separate PID boundary), so code running in the bridge can read `/proc/<ppid>/environ`; ADR 0001 states the master "never reaches a bridge", which is only true of the bridge's env block. It needs a compromised bridge (an attack coming from the gVisor sandbox through the bridge protocol), and the bridge could equally read the orchestrator's own /proc, so the launcher env filtering is defence-in-depth only; "high" overstated.
### 2. Launcher silently does nothing when its path contains URL-special characters
- Verdict: CONFIRMED
- Severity (verified): low
- Location (verified): packages/orchestrator/src/bridge-launcher.ts:85-88
- Duplicate of: none
- Reasoning: For argv[1] `/a#b/bridge-launcher.js`, `new URL("file:///a#b/...").href` keeps `#b/...` as a fragment while `import.meta.url` percent-encodes it as `%23`, so the guard is false and `main()` never runs (exit 0, no output). Needs `#`/`?` in the install path; the deployed path is /code/app so it does not occur in practice. `pathToFileURL` would fix it.
