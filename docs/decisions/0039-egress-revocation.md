# 0039: Revoking open tunnels

Status: accepted, 2026-11-18 (slice 7 of epic #50, issue #256). Builds on [0012](0012-egress-proxy-spike.md) (the tunnel
registry), [0035](0035-egress-proxy-runtime.md) (snapshots, fail closed), [0036](0036-egress-principals.md) (principals)
and [0037](0037-egress-onecli-route.md) (bindings).

## Context

Rules, principals and bindings were enforced when a tunnel was opened. A tunnel that was already open kept working after
the rule that allowed it was deleted, after its session was deleted, after its binding was removed or rotated, and while
the proxy denied everything because its rules went stale. A CONNECT tunnel can stream for an hour. The epic's bar is:
a rule or session delete closes an open tunnel within 10 s on every replica.

## Decision

**Each replica re-judges its open tunnels against every new snapshot.** No replica calls another and nothing is pushed:
every replica already receives the snapshot (NOTIFY plus the 5 s poll, 0035), so each closes its own tunnels.

- The registry entry of a tunnel holds what the decision used: the session, the destination name and port, the addresses
  the decision checked, the route, and, for `route=onecli`, a sha256 of the OneCLI token it was opened with (the token
  itself is never kept).
- After every successful read the loader calls `Proxy.Sweep`. It asks the new snapshot the same question as for a new
  connection (`principalOf`, then `Authorize` with the stored host, port and addresses). A tunnel is closed when:
  - the session has no live principal (`principal-revoked`: session delete or a revoke);
  - the rules deny it (`rule-denied`: a deleted or expired allow rule, a new deny, a changed set membership);
  - the route differs (`route-changed`);
  - it is a onecli tunnel and the session's binding is gone (`binding-removed`) or its token differs
    (`binding-changed`). This closes the rebind race of slice 5: a tunnel opened with the old token right before a
    rotation does not outlive the next snapshot.
- Every successful read sweeps, not only a changed revision, because principal and binding changes do not bump
  `egress.revisions`; a rule that expires is also caught within a poll. The cost is one evaluation per open tunnel per
  poll.
- **Stale closes everything.** When no read has worked for `staleAfter` (2 min), the loader's watcher (a 1 s ticker
  independent of the read loop, which may be blocked in a slow read) calls `Proxy.CloseAll("stale")` once per stale
  episode. Detection takes at most about 1 s after the limit; with a database that stops answering, tunnels end about
  2 min 1 s after the last good read.
- **The decision-to-Track window.** The ACL decision reads the snapshot at one moment, the tunnel is tracked later (after
  the resolve and dial). A snapshot that arrives in between sweeps before the tunnel is registered, so the sweep cannot
  see it. `dial` therefore tracks the connection first and then judges it again against the latest snapshot; if that
  denies it, the tunnel is closed and the client gets an error. Either the re-judgement sees the new snapshot, or the
  snapshot arrived after the tracking and its sweep sees the tunnel. No tunnel survives a snapshot that denies it. This
  replaces the spike's close-time stamps (`revokedAt`, the horizon and the authorization time), which only protected a
  per-session close.
- **Maximum tunnel age** (`EGRESS_MAX_TUNNEL_AGE`, default **1 h**, a start-up setting of the proxy) stays as the
  backstop for anything the re-evaluation could miss. It is not what revokes.
- **The admin endpoint is removed.** `POST /admin/sessions/{session}/close-tunnels` (`EGRESS_ADMIN_TOKEN`) listened on
  the pod's loopback only, so nothing could call it, and the chart never wired it. Revocation is now automatic, so there
  is no use left for a manual call. The registry's `CloseSession` and its `revokedAt` bookkeeping went with it. If an
  operator-facing kill is ever wanted, it should be a database write (a rule or a principal), which every replica honours.
- **Observability.** Each close logs a structured `tunnel-revoked` event with `session`, `host`, `port`, `route` and
  `reason`, never a token. The registry counts revocations (`Registry.Revoked`); the count is not in the status row
  (that needs a migration for little gain), the log is the record.

## Consequences

- The window is poll time, not tunnel life: a revocation reaches a replica in well under a second on a NOTIFY and within
  about 5 s otherwise. The tunnel closes at the sweep that follows.
- Sweeping a snapshot with many tunnels evaluates each one; the evaluator is a pure function over an in-memory snapshot,
  so thousands of tunnels cost milliseconds.
- A tunnel is judged with the session's current principal, so a changed profile (rule sets) also applies to open tunnels.
- A tunnel that is closed mid-stream ends with a reset. Clients see a broken connection and retry, which the new
  snapshot then denies or serves with the new binding.
- Tests: re-evaluation keeps allowed tunnels and closes denied ones, principal revoke, binding rotation and removal, route
  change, stale, a snapshot landing between decision and Track, and tunnels opening while snapshots flip (run with
  `-race`). The live check is `hack/egress-revoke-smoke.sh`.
