You are doing a focused bug hunt on the repository cloned at /workspace/repo (cela: durable Pi agents on Kubernetes; read /workspace/repo/README.md first for orientation).

Rules:
- Static review only. Node is not installed in this sandbox, so you cannot run the tests; use bash, grep, sed, find and git to read code.
- Look for real defects: wrong behaviour, races, crash/restart bugs, security holes, resource leaks, broken error handling. No style or naming nits, no "consider adding tests".
- For every finding, re-read the code to confirm it before reporting. Prefer 3 solid findings over 8 guesses.
- Do not modify anything outside /workspace, do not push, do not open network connections other than what git already did.
- Stay within about 40 tool calls.

Finish with a report in exactly this format (Markdown), and end it with the line END-OF-REPORT:

## Findings
### <n>. <one-line title>
- Severity: high | medium | low
- Confidence: high | medium | low
- Location: <path>:<line>
- What happens: <concrete failure scenario: inputs/state -> wrong result>
- Evidence: <short quote of the relevant code>
- Fix idea: <one or two sentences>

## Areas checked with no findings
<bullets>

END-OF-REPORT
