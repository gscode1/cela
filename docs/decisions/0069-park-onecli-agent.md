# 0069: Park a session's OneCLI agent while its sandbox is suspended

Status: accepted, 2026-11-24 (issue #448). Amends [0002](0002-orphan-sweep.md) (an agent no longer lives as long as its
session) and [0004](0004-idle-suspend.md) (suspend now also releases the repo session's OneCLI agent). Builds on
[0037](0037-egress-onecli-route.md) (the sealed binding).

## Context

A repo session gets its own OneCLI agent `<prefix><uuid>` with two GitHub secrets (and, with a credentialed MCP server,
an agent `<prefix><uuid>-m`, [0040](0040-mcp-egress-flow.md)). They were removed only by session deletion and by the
orphan sweep, which judges deleted and unknown sessions only. Sessions do not expire, and idle suspend closed the Pod but
left OneCLI alone, so the OneCLI workspace held one agent per undeleted session, `failed` ones included, whether or not
the session had run for weeks. An idle agent is useless anyway: its GitHub token lasts an hour and is re-minted only on
use.

## Decision

- **Park on idle suspend.** After the idle suspend has deleted the Pod (`suspendSandbox`), the new `suspended` sandbox
  hook calls `RepoAccess.park`: it revokes the session's agent and its two secrets (agent first, then the secrets, by
  stored id and by name, like teardown) and drops the in-memory access. The workspace stays prepared, so nothing is
  cloned again.
- **After the Pod, not at eviction.** Eviction (120 s) closes only the bridge; the Pod and any background process still
  run. After suspend nothing can use the token.
- **Recreate on demand, with no new path.** The next env open calls `shellEnv`, whose `#ensure` provisions a new agent,
  new secrets and narrow grants, stores the new ids and, behind the egress proxy, seals the new token
  (`bindOneCli` rewrites a binding whose token changed). The resume already waits about 15 s for a Pod; provisioning runs
  in the same open.
- **The binding and session rules stay.** The binding seals a token that is dead after the park; the next `bindOneCli`
  replaces it. Removing and recreating the rules would bump the rules revision twice for nothing.
- **No race with a provision.** `park` waits for a provision in flight, and `ensureAccess` started meanwhile waits for
  the park. Env opens already wait for the suspend (`#replacing`).
- **A 409 on create looks up again.** OneCLI answers 409 for a duplicate identifier, also briefly after the agent of that
  name was deleted. `ensureAgent` now treats a 409 like an ambiguous answer: after the backoff it looks the name up and
  POSTs again only if it is still absent.
- **Best effort.** A failed park is logged (`sandbox-suspended-hook-failed`); the sandbox stays suspended and the agent
  stays until the next suspend, the session's deletion or the sweep.

## Consequences

- The OneCLI agent list holds the repo sessions whose sandbox is running, plus the ones that were not suspended since this
  orchestrator started (a suspend only acts on `Running` sandboxes) and every session's MCP agent.
- With `PI_SANDBOX_IDLE_SUSPEND_SECONDS=0` nothing is parked; agents live as long as their session, as before.
- The first tool call after a resume costs a few more OneCLI calls (create agent, two secrets, grant check).
- The orphan sweep is unchanged: it never judged live sessions, and a parked session simply has no agent.

## Not done here

- **The MCP agent (`-m`).** It has no sandbox signal (its calls come from the orchestrator), and MCP transports hold its
  fetch from connect on. Parking it needs an idle timer and a fetch that re-provisions instead of failing. A follow-up.
