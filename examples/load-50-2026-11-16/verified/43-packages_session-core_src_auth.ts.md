### 1. Configuration accepts tokens that cannot authenticate
- Verdict: CONFIRMED
- Severity (verified): low
- Location (verified): packages/session-core/src/auth.ts:40 (bearer regex at :51)
- Duplicate of: none
- Reasoning: For `alice: abcdefghijklmnop` the token is `" abcdefghijklmnop"` (leading space; length 17 >= 16), which passes the check at line 40 and is hashed with the space. A client can only send `Bearer +(\S+)`, which captures `abcdefghijklmnop`, whose digest differs, so that owner can never authenticate and nothing flags it at startup. Same for any interior whitespace. Misconfiguration only; fails closed.
