### 1. Accepted strings can cause database errors
- Verdict: CONFIRMED
- Severity (verified): low
- Location (verified): packages/ingest/src/events.ts:21-22,26-33
- Duplicate of: none
- Reasoning: `{"kind":"message","text":"a\u0000b"}` passes `parseEventBody`. `enqueueEvent` (store.ts:214) does `JSON.stringify(payload)` cast `$5::jsonb`; Postgres rejects `\u0000` in jsonb (22P05), as it does a lone surrogate escape. The error is not a BodyError, so server.ts:42-44 answers 500 "internal error" and logs it; nothing is queued. A NUL in `sourceEventId` fails the text column similarly. Authenticated caller only; effect is a wrong status code (500 vs 400), no corruption.
