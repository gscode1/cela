# Self-hosted board spike (2026-11-19)

Historical observations from one example environment (issue #306). Nothing in pi-durable-k8s changed for this spike,
and the spike code is not in the repository; the snippets below are what it needs.

## Question

Can we run a shared board, where people and agents post work, claim tasks and report results, on our own
infrastructure, with pi-durable-k8s as one agent backend?

Vercel Board does this, but it is a SaaS product, which we do not want to depend on. Its code,
[vercel/board](https://github.com/vercel/board) (npm `@vercel/board`, tested at 0.52.0), is Apache-2.0. Its spec
(`SPEC.md` in that repository) describes the protocol, the grants, the tasks and the sync.

## Summary

| Question | Answer | Evidence |
|---|---|---|
| Can it be self-hosted without Vercel? | **Yes, as one replica** | The package ships `board()` (HTTP, auth, grants, SSE), a local backend (`@vercel/board/backend-local`, SQLite), the CLI `vb`, a web viewer (`vb inspect`) and a conformance kit. Only Vercel's hosted backend is closed |
| Can it use our own authentication? | **Yes** | `board({ authenticate })` accepts any verifier; static bearer tokens worked |
| Does the protocol hold on our server? | **Yes** | `vb conformance`: 85 passed, 0 failed, 5 skipped. The skipped checks are grants checks that need teams or apps |
| Can grants restrict an agent? | **Yes** | An agent limited to `dev/` was refused when it posted to `security` |
| Can a board task run as a pi session with no change to pi-durable-k8s? | **Yes** | It ran live against the c2 lab stack, see Results |
| Does it run in Kubernetes? | **Yes** | It ran in its own namespace on c2, under Pod Security `restricted`, and kept its data across a pod restart |
| Can a pi session use the board itself (post, create subtasks)? | **Not tested** | See Open points |

## How it fits together

```
person / agent --vb--> board (board() + local SQLite backend, static tokens)
                         ^
dispatcher: vb tasks run --ready dev --from local:user:ops -- node pi-task.mjs
                         |  claims, renews the lease while it runs, completes on exit 0, fails otherwise
                         v
              pi-task.mjs --stdio--> packages/mcp (run_task, wait) --HTTP--> ingest --> pi session (gVisor sandbox)
```

**The board server.** It is about 40 lines: `board()` on the local backend, plus a verifier that maps a static
bearer token to a person, plus a Node `http` adapter for `board.fetch`.

```js
const team = board({
  backend: local({ dir: process.env.BOARD_DIR }),
  url: process.env.BOARD_PUBLIC_URL, // every request is built on this URL, so a port-forward works too
  authenticate: ({ credential }) => {
    if (credential === null) return null
    const name = lookUp(credential) // BOARD_TOKENS = {"<token>": "<name>"}, compared in constant time
    if (!name) return new Response('{"error":"unknown token"}', { status: 401 })
    return { id: `local:user:${name}`, kind: 'person', handle: name }
  },
})
```

**The dispatcher.** `vb tasks run` does the claim, the lease renewal and the outcome. The script it starts does the
rest:
1. It reads the task with `vb read $BOARD_TASK --json`.
2. It starts a pi session with the task text, through the MCP adapter (`run_task`). A `repo` label on the task becomes
   the session's repository.
3. It replies on the thread with `Started pi session <id>`, labelled `pi.session=<id>`.
4. It calls `wait` until the turn is done, then replies with the agent's text.
5. It exits 0 when the session finished, so the task completes, and 1 when it failed or timed out, so the task fails.

The script talks to pi only through the MCP adapter, which is a plain client of the session API.

**Claims are fenced leases.** Every claim raises the task's epoch. A write that carries an older claim gets
`409 claim_lost`, so a stalled dispatcher cannot settle a task that another dispatcher has since taken over.

**Agents are told apart by profile.** An agent writes under a profile of its principal, shown as
`pi-session-abc via pi-coder`. A profile carries no permission of its own.

## Results

- **Local end-to-end test.** The board and the dispatcher ran against an auto-responding fake of the session API.
  - A successful run completed the task, posted both replies and set the `pi.session` label.
  - A run that ended with `runFailure` failed the task and posted the failure reply.
- **Live on c2.** The board and the dispatcher ran on the operator machine and reached `pi-ingest` of `pi-durable-poc`
  through a port-forward, as a client only.
  - The task asked the agent to create a NOTES.md with a three-line summary of a PodDisruptionBudget.
  - It completed in about 46 s. The session ran on profile `coding` v4 with model `openai-codex/gpt-6-luna` and used
    1,709 tokens ($0.0002).
  - The reply on the thread is the agent's own claim. The session was deleted afterwards, so the file was not checked.
- **The board in the cluster.** It ran in namespace `pi-board-spike`, apart from the platform's namespace.
  - No image was built or pushed. The stock `node:22-bookworm-slim` image, pinned by digest (its index includes
    arm64), ran `npm ci` in an init container from a ConfigMap that held the server and the lockfile.
  - Pod Security `restricted` admitted it with no warning: non-root, all capabilities dropped, read-only root
    filesystem, no service-account token.
  - Through a port-forward, grants worked, and a task created as `ops` was claimed and completed as `pi-coder`.
  - The completed task was still there after the pod was deleted and recreated (SQLite on a 1 Gi Longhorn PVC).
  - The dispatcher was not pointed at this in-cluster board.

## Findings

- **The local backend is for development.** The spec says so ("for development, `vb serve`, tests, and working
  offline"). It runs in one process with SQLite on a PVC and needs `strategy: Recreate`, the same shape as one
  orchestrator shard.
  - To go further, we would need a Postgres backend behind the board's `Backend` interface, checked with the
    conformance kit. It would make a good upstream contribution.
  - Node prints an experimental warning for `node:sqlite`.
- **Watchers wake nothing when self-hosted.** Wake-by-URL answers `501 no_wake_by_url` on the open engine. A
  self-hosted dispatcher has to pull instead: `tasks run --ready … --wait`, or `tail`.
- **Tasks belong to their owner.** `claim --ready` only takes tasks assigned to the claimer or owned by it.
  - To take another owner's tasks, the claimer must pass `--from <owner actor id>`, which works only with `--ready`.
    The other way is for the owner to run `tasks assign --pool`.
  - So a dispatcher has to name the owners it serves.
- **By default, every person can do everything.** The default grant `--all-users` (g1) lets every authenticated person
  do everything, so every token is in effect an admin.
  - First grant the operator `*=all`, then revoke g1. The revoke needs `manage` on `*`.
  - A grant names a host user by the bare name (`--user ops`), not by `local:user:ops`.
- **Ids are message ids.** Task and message ids come from one counter for the whole board, so they skip numbers.
  Replies use up ids too.
- **There is no MCP server.** Agents use the CLI, the SDK or HTTP. The CLI needs Node 22.18 or later.
- **The live run used an admin token.** The lab stack had only the admin token `alice`. A real dispatcher should get
  the token of an owner who is not in `PI_API_ADMINS` (see [the MCP adapter](../mcp-adapter.md)).
- **Publishing an image would make it public.** c2 has no image pull secrets, so an image pushed to ghcr would have to
  be public. The run-from-ConfigMap pattern avoids publishing anything, but it needs npm egress from the namespace.

## Open points

1. **Session to board.** For a pi session to post to the board or create subtasks, there are two options:
   - A private egress rule for the board (`board.<ns>.svc.cluster.local` on an explicit port, the private tier of
     [ADR 0034](../decisions/0034-egress-rules.md)), plus the CLI in the sandbox image (it has no Node today), plus a
     board token inside the sandbox.
   - A small MCP wrapper around the board, registered as a credentialed catalog server and called by the orchestrator
     ([ADR 0040](../decisions/0040-mcp-egress-flow.md)). No token enters the sandbox, which keeps the rule that the
     sandbox holds no credentials.
2. **Identity per session.** All pi sessions share one board token. The profile header (`x-board-profile`) names the
   session, but the caller sets it itself, so the board cannot verify it.
3. **Routing.** The spike sends one channel and label to one profile. A real dispatcher needs rules from channel,
   labels and repository to a pi profile and sandbox size, with a capacity limit per profile.
4. **Where it lives.** The board and the dispatcher belong in a separate project. pi-durable-k8s needs no change for
   the dispatcher path.
