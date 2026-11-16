## Findings

### 1. Bridge can read the launcher’s master key through `/proc`

- Severity: high
- Confidence: high
- Location: packages/orchestrator/src/bridge-launcher.ts:72
- What happens: The launcher retains the orchestrator’s full environment while its bridge child runs. In the deployed Linux container, both processes run as the same user, so a compromised bridge can read `/proc/<parent-pid>/environ` and recover the sandbox master key and other credentials. Filtering the child’s environment therefore does not enforce the intended per-claim credential isolation.
- Evidence: `spawn(process.execPath, [cli, ...args], { env, stdio: "inherit" })`
- Fix idea: Put the bridge in a separate security boundary that cannot inspect the launcher or orchestrator processes, such as a separate pod or appropriately isolated UID and PID namespace.

### 2. Launcher silently does nothing when its path contains URL-special characters

- Severity: low
- Confidence: high
- Location: packages/orchestrator/src/bridge-launcher.ts:87
- What happens: If the repository or installation path contains `#` or `?`, constructing a file URL by string interpolation treats part of the path as a fragment or query. The comparison fails, `main()` is not called, and sandbox connections exit without starting the bridge.
- Evidence: `import.meta.url === new URL(\`file://${process.argv[1]}\`).href`
- Fix idea: Convert the filesystem path with `pathToFileURL()` before comparing it with `import.meta.url`.

END-OF-REPORT
