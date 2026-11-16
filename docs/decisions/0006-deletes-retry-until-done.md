# 0006: Deletes retry until they succeed

Status: accepted, 2026-11-16 (issue #18).

## Context

`InboxLoop` marks an event `failed` after `MAX_ATTEMPTS` (5) tries. The poll interval is 1 s, so five tries fit in a
few seconds. A `delete` event that hits a short Kubernetes or OneCLI outage therefore ended `failed` while the session
stayed `deleting`. Nothing recovered from there: a repeated `DELETE` was deduplicated onto the failed row, the orphan
sweep treats `deleting` as live (ADR 0002), and no code path resets a failed row. The sandbox, PVC and OneCLI agent
leaked for good.

## Decision

- A `delete` row has no attempt cap. A failing delete is retried with an exponential backoff (1 s doubling to 60 s),
  kept in memory per session. Only `PermanentError` (the session row is missing or already `deleted`) ends it `failed`.
- A repeated `DELETE` re-queues a delete row that is `failed` (`requeueFailedDelete`), so rows that failed before this
  change, or a permanent error that was fixed since, can be retried by the client.
- The sweep is unchanged: it still never touches `deleting` sessions. Deleting is retried by the loop that owns it, so
  a second actor does not race the teardown.
- The server's delete row has its own dedup source (`system:delete`, session id), so a client-chosen `sourceEventId`
  such as `delete:<id>` cannot occupy its key.

## Consequences

- A delete against a permanently broken backend retries every 60 s indefinitely and logs `event-failed` each time; this
  is visible, where the old behaviour was silent leakage. It also holds that session's inbox batch (other sessions are
  unaffected). A session in `deleting` accepts no new events anyway.
- Delete rows written before this carry `api:<owner>` / `delete:<id>`; they stay valid and a new `DELETE` adds a row
  under the new key. A second delete row for a session that is by then `deleted` ends `failed` ("session is deleted"):
  harmless.
- Rejected alternative: letting the sweep finish `deleting` sessions after a grace period. It would duplicate the delete
  path in a second process loop and needs a time-based guess at "stuck".
