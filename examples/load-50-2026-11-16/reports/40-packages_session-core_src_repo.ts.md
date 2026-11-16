## Findings

### 1. Validation accepts trailing line terminators
- Severity: low
- Confidence: high
- Location: packages/session-core/src/repo.ts:11
- What happens: JavaScript’s `$` anchor can match before a final line terminator, so inputs such as `octo/hello\n` and `main\n` pass the respective character-class checks. The API can create a session with an invalid repository or branch instead of returning 400; the later clone fails.
- Evidence: `const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;` and the `REF` pattern uses the same anchor.
- Fix idea: Require an actual end-of-input match, or explicitly reject line terminators before applying the patterns.

### 2. Branch validation misses `.lock` in intermediate components
- Severity: low
- Confidence: high
- Location: packages/session-core/src/repo.ts:38
- What happens: A branch such as `feature.lock/foo` passes validation, although Git rejects any ref component ending in `.lock`. The API creates the session, but the requested branch cannot be cloned.
- Evidence: `branch.endsWith(".lock")` checks only the end of the whole branch name.
- Fix idea: Reject `.lock` at the end of every slash-separated component.

END-OF-REPORT
