# OneCLI v2 host rules (public egress allowlist)

Why: OneCLI v2.20.0 refuses private, cluster and metadata targets, but it relays **any public host** for a valid agent
token (`docs/research/onecli-v2-recheck.md`, section 2). The `Default Rule: block` switch (`/v1/org/policy/default`) does
not change that: it only applies to credentialed non-LLM requests. The working allowlist is ordered explicit org rules:
`allow <host>` for each host, then `block *`. That test returned 403 for every host not allowed and 200 with injection for
`openrouter.ai`.

This is the gateway-side control (what a leaked token can ask for). The pod-side control is the Cilium FQDN allowlist
in `deploy/onecli-policies/egress.yaml`; keep both lists identical.

## The rule set

Rule shape (recheck doc): `{"name", "action": "allow|block", "targets": [{"kind": "network", "hostPattern"}]}`, at
`POST /v1/org/policy/rules`, effective immediately. No `pathPattern` or `method`: path rules are bypassable (`..`,
`/repositories/<id>`), so the boundary is the host. Repository scope comes from the per-session GitHub App token, not from here.

| # | action | hostPattern | Why |
|---|---|---|---|
| 1 | allow | `chatgpt.com` | Codex subscription calls (credential injected) |
| 2 | allow | `*.chatgpt.com` | same, subdomains |
| 3 | allow | `auth.openai.com` | OAuth token refresh |
| 4 | allow | `api.openai.com` | OpenAI API |
| 5 | allow | `openrouter.ai` | OpenRouter models |
| 6 | allow | `github.com` | git clone and push over HTTPS (Phase 4c) |
| 7 | allow | `api.github.com` | GitHub API, installation-token mint if it goes through the gateway |
| 8 | allow | `codeload.github.com` | archive downloads |
| 9 | allow | `objects.githubusercontent.com` | release and LFS objects |
| 10 | allow | `registry.npmjs.org` | npm |
| 11 | allow | `pypi.org` | pip index |
| 12 | allow | `files.pythonhosted.org` | pip files |
| 13 | allow | `mcp.deepwiki.com` | remote MCP server (DeepWiki, no auth), only used when the MCP catalog (`/admin/mcp-servers`) has it enabled |
| 14 | block | `*` | everything else, **created last** |

Order is the point: rule 14 must be created after rules 1 to 13. The script keeps that invariant (see below).
Whether the gateway evaluates in creation order or by specificity is UNVERIFIED beyond the recheck test (allow then block
behaved as an allowlist); check with the probes below after applying.

## Apply

`deploy/onecli-host-rules.sh`, applied on c2 on 2026-11-16 (the org had no rules before). Dry run by default.

```sh
deploy/onecli-host-rules.sh            # prints the plan, makes no request
deploy/onecli-host-rules.sh --apply    # needs the admin key
```

- Admin key: Secret `secret-store/pi-onecli-admin`, key `api-key`, read with `kubectl` (or `ONECLI_API_KEY`). It goes to
  curl on stdin and is never printed. This is the admin key the plan says must never live in the orchestrator: run the
  script from an operator machine only.
- `ONECLI_URL` (required): the OneCLI API base, e.g. `https://onecli.example.com`. Use `http://localhost:10256` with
  `kubectl -n onecli port-forward svc/onecli 10256` if the Cilium ingress policy has closed the route.
- Idempotent by rule name (`pi-allow-<host>`, `pi-block-all`). Adding a host later: add it to `hosts` in the script and to
  `egress.yaml`, rerun; the script creates the missing allow rules first, while `pi-block-all` still exists, then deletes
  and recreates the block last. If creating an allow rule fails, the old block is untouched (the allowlist stays on).
  Only between the block DELETE and its POST is there no block rule (the gateway relays public hosts as before): an
  EXIT trap recreates the block if anything fails in that step, and prints a "rerun with --apply NOW" message if even
  that fails. Do it when no session is running. Whether the gateway evaluates by creation order is UNVERIFIED, so a
  new allow rule created before the block is recreated may be ineffective until the block is recreated last; that is
  fail-closed.
- The list response is a bare array (seen on 2026-11-16, empty before the first apply). UNVERIFIED: `DELETE
  /v1/org/policy/rules/<id>` and the id field (not exercised yet).

## Verify after applying

From a pod that holds an agent token (the orchestrator has one; do not print it), through `:10255`:

- `https://openrouter.ai/api/v1/key` returns 200 with the secret injected.
- `https://example.com` and `https://api.ipify.org` return 403.
- `https://github.com/<public repo>.git/info/refs?service=git-upload-pack` returns 200 (a private repo needs the session token).

## Result (2026-11-16)

Probes from the orchestrator pod through `:10255` with its agent token (not printed), right after `--apply`:

| Target | Status |
|---|---|
| `https://example.com/` | 403 |
| `https://api.ipify.org/` | 403 |
| `https://github.com/<owner>/<repo-a>.git/info/refs?service=git-upload-pack` | 200 |
| `https://registry.npmjs.org/left-pad` | 200 |
| `https://chatgpt.com/` | 200 |

The Cilium FQDN policy on the OneCLI pod (argo-c2 `applications/onecli`) is the second layer: a host allowed here but
missing there fails to connect.

Sandboxes still reach public hosts directly (`sandbox-allow-internet-egress`, decision 2026-11-15), so this list only
limits what goes through the gateway: model calls and git with injected credentials. Routing sandbox traffic through the
gateway too would need `HTTPS_PROXY` in the sandbox, the OneCLI CA in every tool, and the package hosts each session
needs on this list. It is not done; revisit before real use with untrusted code.

## Rollback

List rules with `GET /v1/org/policy/rules` and delete `pi-block-all` first (restores relaying of public hosts as in
v2.20.0 defaults), then the `pi-allow-*` rules if wanted. Deleting only the block rule is enough to undo the restriction.

## MCP servers: a catalog row does not open egress

An MCP server in the catalog (`inbox.mcp_servers`, managed through `/admin/mcp-servers`, ADR 0009) is only a name and a
URL. Adding a row never allows its host: the orchestrator reaches it through the OneCLI gateway, so the host must also
be allowed here (a rule in `deploy/onecli-host-rules.sh`, applied before the final block rule) and in the orchestrator's
egress policy (`deploy/onecli-policies/egress.yaml`). Until both allow it, the server fails to connect: the orchestrator
logs `mcp-discovery-failed` with the retry delay, and calls to its tools settle `tool_unavailable`. The admin API does
not probe the network, so it reports reachability as `unknown`; the log is the signal. Add the rule first, then the row.
