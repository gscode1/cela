## Findings

### 1. Accepted strings can cause database errors
- Severity: low
- Confidence: high
- Location: packages/ingest/src/events.ts:21
- What happens: A message containing a NUL character, such as `{"kind":"message","text":"hello\u0000world"}`, passes validation but PostgreSQL rejects it when the payload is inserted as JSONB. The request receives a 500 instead of a validation error, and the event is not queued. A NUL in `sourceEventId` has the same problem with its PostgreSQL text column.
- Evidence: `typeof text !== "string" || text.trim() === ""` checks type and emptiness, while the subsequent check only limits length.
- Fix idea: Reject NUL characters in both fields before enqueueing, with a 400 response. Also validate other Unicode sequences PostgreSQL JSONB cannot store, such as unpaired surrogates.

END-OF-REPORT
