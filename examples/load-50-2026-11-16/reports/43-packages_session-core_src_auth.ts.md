## Findings

### 1. Configuration accepts tokens that cannot authenticate
- Severity: low
- Confidence: high
- Location: packages/session-core/src/auth.ts:40
- What happens: A token containing whitespace, such as `alice: abcdefghijklmnop`, passes configuration validation, but no bearer header can authenticate with it. The service starts normally while requests for that owner fail authentication.
- Evidence: Validation checks only `token.length < MIN_TOKEN_LENGTH`, whereas the bearer parser requires `(\S+)`.
- Fix idea: Reject configured tokens containing whitespace, with an error that does not echo the token.

END-OF-REPORT
