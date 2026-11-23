# Final review: drop OneCLI, extend the egress proxy, add TCP?

2026-11-23. Independent review of `00-brief.md`, `10`–`13` and `20`. Not a decision. "Verified" means I read the source,
not that I ran it.

## 1. Bottom line

Do not do this as framed. The idea is "add the minimum functions to the egress proxy", and the honest minimum is
**zero**: nothing OneCLI does for cela has to live in the proxy. Do a reduced version instead: retire OneCLI by making
credentials boring (a short-lived repo token in the sandbox, static keys in a Kubernetes Secret read by the orchestrator,
the Codex login in one Postgres row), with no MITM, no CA and no injection code anywhere. That is roughly 3–4 focused weeks
(my estimate, not measured) against the debate's 5–10, and the first slice (GitHub) is worth doing even if you stop
there. If OneCLI is not actually costing you time week to week, doing nothing is also defensible: its security gaps are
closed by the network and already accepted in ADRs 0042 and 0043. TCP is a separate, small topic and should not ride on
this.

## 2. What the debate got right and wrong

**Right**

- No general injector, no vault, no dashboard in the proxy (`10`, `12`); model and MCP credentials belong in the
  orchestrator. `AGENT.md` already says so literally: "model credentials stay in the orchestrator". Only `plan.md:173` needs amending.
- Stock goproxy MITM must not be switched on (`10`, `11`). Verified: `goproxy/proxy.go:253` builds the transport with
  `tlsClientSkipVerify` and `ProxyFromEnvironment`.
- `13` is right that `12`'s `ConnectHijack` plan cannot work. Verified: Smokescreen's one CONNECT handler returns
  `OkConnect` or `ConnectMitm` (`smokescreen.go:1033-1063`) and goproxy stops at the first handler (`https.go:120-129`).
- `13` is right that option A's benefit is narrow (off-cluster use of a one-repo token for at most an hour) and that static secrets
  need a Secret, not an encrypted table with an import CLI.
- CONNECT, not SOCKS5 (all documents).

**Wrong or overcomplicated**

- **`10`/`12` recommend A.** A puts a CA key, TLS termination and every live repo token into the one process that faces
  hostile sandbox traffic, to protect a token the sandbox can already exercise in full. For a proof of concept that is
  a bad trade, and 10–18 days of it.
- **The judged-IP undici transport and the TS port of `Platform` (`12`, kept by `13`).** ADR 0043 states the premise
  itself: the orchestrator runs no model code and its MCP URLs are set by trusted admins. Today's real address control is
  the OneCLI Pod's NetworkPolicy (public rule, RFC 1918 on 443 only, metadata and CGNAT blocked). Move that same rule to
  the orchestrator Pod, keep `redirect: "error"` and bind each credential to its configured origin (the pattern ADR 0056
  already uses for direct providers). The DNS-rebinding residual stays where 0043 already accepted it.
- **Enterprise process on a proof of concept (`12`, partly `13`):** 60-day and two-release migration windows, 1 GiB
  benchmarks with CPU gates, a four-week soak, CA client matrices, an independent security review. `plan.md:4` says
  production hardening is out of scope. Re-enter secrets, cut over, delete.
- **`13`'s 15-minute remint-and-revoke for B.** More moving parts, and it cuts long tool calls. A one-hour, one-repo
  token is the same class of credential GitHub Actions hands every workflow.
- **Both sides missed that B's delivery channel already exists.** `13` designs a tmpfs file; the standard sandbox template
  has no tmpfs (only the browser's `/dev/shm`). But `buildShellEnv` (`workspace.ts:60-84`) already hands every repo
  session a per-session credential through `shellEnv`, and `beforeUse` plus `envStale` (`sandboxes.ts:296-304`,
  `repo-access.ts:136-148`) already remint before a tool call and reopen the env when the credential changes. B is: put
  the real token in `GH_TOKEN` and add a one-line git credential helper through the `GIT_CONFIG_*` variables already in use.
- **Estimates treat 297 OneCLI-mentioning files as migration scope.** Most are docs, tests and historical research; the
  orchestrator source touchpoints are four files of about 1,000 lines.

## 3. The options

| | Verdict for this project |
|---|---|
| **A** proxy MITM | **No.** Highest cost, adds the largest new attack surface, keeps the HTTP/1.1 limit, and rebuilds the part of OneCLI you like least to own. |
| **B** short-lived token in the sandbox | **Yes, first.** 2–4 days. Deletes `route=onecli`, the upstream chaining, the sealed bindings and seal key in the proxy, per-session OneCLI agents for repos, and the unconstrained OneCLI CA that every repo sandbox trusts today (`workspace.ts:98-104`). `gh` (baked into the image) and HTTP/2 just work. Works with the proxy disabled. |
| **C** keep OneCLI | **Legitimate.** Zero work, known behaviour. Loses on operational weight (three releases, second Postgres, bootstrap tied to observed behaviour), not on security. Choose it if the weeks are better spent on product. |
| **D** reverse-proxy injection endpoint | **Only if "no portable token in a sandbox" is non-negotiable.** No CA, same custody as A. But `gh` insists on HTTPS to `api.github.com`, so it needs a shim (unverified), and it adds a second listener and path mapping. A simpler variant: accept absolute-form `http://github.com/...` forward requests on the existing listener and upgrade to TLS upstream; still no `gh`. |

**B's real costs, stated plainly.** The token is visible to every process in the sandbox and will sometimes be printed
into a transcript, which is persisted and sent to the model provider; it is dead within the hour. `shellEnv` is fixed
when the env opens, so a single tool call that outlives the token's remaining validity fails mid-command; raise the
remint margin from 10 to about 30 minutes. `plan.md:173` ("neither … hold real secrets") must be amended; ADR 0042 already
made it untrue for the orchestrator.

**What everyone missed.**

- **E: a stable half-way end state.** After B, OneCLI serves the orchestrator only. Sandboxes and the proxy have no path
  to it and the proxy holds no secret at all. That is a coherent place to stop, not a temporary shrink (`13`'s D2 is the mirror image and worse).
- **Codex is the critical path.** The default model runs on the Codex subscription (`plan.md:209`), so full removal is
  hostage to the hardest slice: rotating refresh tokens and unclear terms of use. The fallback store sketched in
  `docs/model-credentials.md` ("Fallback: our own credential store") is the starting point; with one replica per shard, a
  Postgres advisory lock around pi-ai's `CredentialStore.modify` is small. If it fails, stop at E.

Ranking: **B then stop-or-continue (E) > C > D > A.**

## 4. TCP on its own merits

It mostly exists. CONNECT already tunnels any TCP, rules already carry `ports`, and `egressProxy.publicPorts` is a chart
value. Nothing in the proxy needs to change to reach `db.example:5432` from a client that can speak CONNECT.

What is actually missing is on the client side: `ssh`, `psql` and most non-HTTP clients ignore `HTTPS_PROXY`. A SOCKS5
listener does not fix that, because those clients do not speak SOCKS unprompted either; a transparent capture would, and ADR 0038
rejected it for good reasons. So: no SOCKS5, no UDP, no injection on raw TCP. When a concrete workload appears, add a
client adapter to the image (`ssh -o ProxyCommand`, or `proxychains-ng` as `13` suggests) and one e2e test on a
non-443 port. The half-close fix through `ConnectCopyHandler` is real but only matters for protocols that send FIN and
keep reading; do it (about a day) when a client needs it. No demand is recorded anywhere in the documents, so today
the right amount of TCP work is a paragraph in the docs. For git, rewrite SSH remotes to HTTPS rather than open port 22.

## 5. If you proceed

**Slice 1: GitHub without OneCLI (B through `shellEnv`).** `repo-access.ts` stops creating OneCLI agents and secrets;
it mints as today and returns the token in the env with a git credential helper; the CA bundle write in
`workspace.ts` goes away; `github.com` and `api.github.com` become ordinary `route=direct` rules; `RouteOneCLI`,
`selectUpstream`, `authUpstream`, `binding.go` and `egress.bindings` are deleted. Teardown calls
`DELETE /installation/token` best-effort.

**Acceptance.** The existing phase-4c suite passes with no OneCLI path for sandboxes: clone, push, branch delete,
`gh pr create`, push to another repository refused. Plus: a tool call started 25 minutes before expiry completes; a
second call after remint sees the new token; no CA variable is set in the sandbox; ALPN to `github.com` is `h2`; the
proxy Pod mounts no seal key. `pnpm check` green. One ADR superseding 0037 and amending `plan.md`.

**Kill criterion.** Stop and keep C if slice 1 is not merged within five working days, if a real workflow you rely on
(LFS, submodules, long pushes) cannot be made to pass, or if you are unwilling to sign the `plan.md` amendment. In the
last case spike D for one day, and if `gh` cannot be made to work, keep OneCLI.

**Then, each with its own stop point:** (2) API-key providers and MCP bearer tokens from a mounted Secret, the
NetworkPolicy moved from the OneCLI Pod to the orchestrator, one invariant test that a credential is never attached to
another origin; (3) Codex with a wrapped OAuth provider and a forced-rotation test across two shards; kill = any
unexplained lost login, stay at E; (4) delete `charts/pi-onecli`, the bootstrap, the reconciler and `onecli.ts`.

## 6. Confidence and what I could not verify

Direction (nothing in the proxy; B over A; TCP decoupled): **high**. Estimates: **low to medium**; they are judgment.
Whether to do anything at all: **medium**; it depends on how much OneCLI costs you in practice, which only you know.

Not verified by me:

- pi-ai 1.6.0 internals cited in `12`/`13` (`CredentialStore.modify`, the global `fetch` in Codex refresh, the
  token-bearing error). The package is not installed in this worktree; I relied on `13`.
- `gh` behaviour against a non-HTTPS or path-mapped endpoint (decides D).
- GitHub token revocation semantics, LFS and submodule behaviour under B, and the long-tool-call expiry interaction (reasoned from code, not run).
- OpenAI's refresh-token rotation behaviour and whether server-side use of a ChatGPT subscription is permitted.
- That the CNI treats an orchestrator-side `ipBlock` rule the way it treats the OneCLI Pod's today.
- How many installs exist besides the owner's; I assumed few, which is why I discard the migration windows.
