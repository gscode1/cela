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
  kept in memory per session. Only `PermanentError` (the session row is missing) ends it `failed`; a session that is already `deleted` just gets its tombstone closed.
- A repeated `DELETE` re-queues a delete row that is `failed` (`requeueFailedDelete`), so rows that failed before this
  change, or a permanent error that was fixed since, can be retried by the client.
- The sweep is unchanged: it still never touches `deleting` sessions. Deleting is retried by the loop that owns it, so
  a second actor does not race the teardown.
- `DELETE` writes `status = 'deleting'` and the delete row in one transaction (`beginDelete`), so a crash between them
  cannot leave a `deleting` session with no delete row. A repeated `DELETE` also heals a session already stuck that way.
- The server's delete row has its own dedup source (`system:delete`, session id), so a client-chosen `sourceEventId`
  such as `delete:<id>` cannot occupy its key.

## Consequences

- A delete against a permanently broken backend retries every 60 s indefinitely and logs `event-failed` each time; this
  is visible, where the old behaviour was silent leakage. It also holds that session's inbox batch (other sessions are
  unaffected). A session in `deleting` accepts no new events anyway.
- Delete rows written before this carry `api:<owner>` / `delete:<id>`; they stay valid and a new `DELETE` adds a row
  under the new key. A second delete row for a session that is by then `deleted` completes the tombstone if it is still open and ends
  `submitted`. (It used to end `failed`, and a delete that died between `status = 'deleted'` and `completeTombstone`
  could never close its tombstone.)
- Rejected alternative: letting the sweep finish `deleting` sessions after a grace period. It would duplicate the delete
  path in a second process loop and needs a time-based guess at "stuck".

## Addendum: backed-off sessions stay out of the poll (issue #95)

The in-memory backoff above (`#notBefore` in `InboxLoop`) is now also applied in the poll query itself: sessions in flight
or waiting out a backoff are excluded from the `limit 100` page and the oldest pending event is served first
(`InboxLoop.#tick`), so many deleting sessions cannot starve the others. The retry rule is unchanged. The loop is per
shard since [0017](0017-schema-sharding.md) (the query filters on `s.shard`).

## Addendum: a delete does not wait forever for the abort (issue #180)

`Conversation.abort()` resolves only once the conversation is idle, and it runs inside the inbox claim transaction. A
tool that ignores its abort signal would hold that transaction, a pool client and the row locks, and every retry would
hit the same wait. Every abort from the session service now waits at most 30 s (`abortWaitMs`); the abort mark and the
withdrawal of queued inputs are committed before the wait either way. A `delete` whose wait times out goes on to delete
the sandbox, which ends the stuck tool. A `cancel` or a failed session's abort fails the row, which the inbox retries.

## Addendum: every retryable row backs off (issue #204)

The backoff above now applies to every row that fails with a transient error, not only `delete`. A `message` or `steer`
retried on the 1 s poll ended `failed` after five tries, inside the same short OneCLI, GitHub or Kubernetes outage this
ADR describes, and the user's input was lost. A failing row of any kind puts its session into the in-memory backoff (1 s
doubling to 60 s, `retryDelayMs`); a failed prepare counts the same. Rows other than `delete` still end `failed` after a
cap, raised from 5 to 8 attempts so the retries span about two minutes (1+2+4+8+16+32+60 s). A `delete` still has no
cap.
