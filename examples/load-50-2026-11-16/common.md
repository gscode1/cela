You are doing a focused bug hunt on ONE file of the repository cloned at /workspace/repo (cela: durable Pi agents on Kubernetes; README.md has the overview).

Rules:

- Read the primary file fully. Read callers and callees only as needed to confirm a finding.
- Static review only: Node is not installed in this sandbox, so you cannot run tests. Use bash, grep, sed and git.
- Real defects only: wrong behaviour, races, crash/restart bugs, security holes, leaks, broken error handling. No style nits.
- Re-read the code to confirm every finding before reporting. Zero findings is a fine answer.
- Do not modify anything outside /workspace, do not push. Stay within about 25 tool calls.

Finish with exactly this Markdown, ending with the line END-OF-REPORT:

## Findings

### <n>. <title>

- Severity: high | medium | low
- Confidence: high | medium | low
- Location: <path>:<line>
- What happens: <concrete failure scenario>
- Evidence: <short code quote>
- Fix idea: <one or two sentences>

(or "## Findings\nNone." if there are none)

END-OF-REPORT
