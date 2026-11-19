# OneCLI v2 host rules (optional hardening: a public egress allowlist)

**This is optional hardening, not the default** ([ADR 0043](decisions/0043-open-onecli-defaults.md)). The bundled OneCLI is installed
open: the bootstrap makes no host rules and no `block *` unless `ONECLI_HOSTS` is set, so OneCLI relays any host a valid agent token
asks for and, with the private destinations the chart opens, an admin-named LAN MCP server on :443. Use this page when the gateway
must relay nothing but a list you choose. Three independent tools harden OneCLI, and you can use any of them:

| Tool | Effect |
|---|---|
| host rules: `ONECLI_HOSTS="h1 h2 ..." hack/onecli-bootstrap.sh -n NS` (or `hack/kind-up.sh` with it exported), or `hack/onecli-host-rules.sh --apply` | an allow rule per host, then `block *` |
| `--set gateway.allowPrivateDestinations=` on the upstream chart, and `gateway.privateHttps.enabled=false` on `charts/pi-onecli` | OneCLI refuses private destinations again, and the network policy no longer admits them |
| `hack/onecli-policies/egress-strict.yaml` (Cilium, external OneCLI) | the FQDN allowlist and the full private deny, for the OneCLI Pod |

**The new default does not remove an existing `pi-block-all`.** An install bootstrapped before this change keeps the block (the
bootstrap warns about it and never deletes it), and `hack/onecli-host-rules.sh` or an old bootstrap creates it again. To open such
an install, delete the rule through the API (see Rollback). `ONECLI_HOSTS` keeps the behaviour described below: allows, then the
block last.

Why this list exists: OneCLI v2.20.0 refuses private, cluster and metadata targets, but it relays **any public host** for a valid agent
token (`docs/research/onecli-v2-recheck.md`, section 2). The `Default Rule: block` switch (`/v1/org/policy/default`) does
not change that: it only applies to credentialed non-LLM requests. The working allowlist is ordered explicit org rules:
`allow <host>` for each host, then `block *`. That test returned 403 for every host not allowed and 200 with injection for
`openrouter.ai`.

This is the gateway-side control (what a leaked token can ask for). The pod-side control is the Cilium FQDN allowlist
in `hack/onecli-policies/egress-strict.yaml`; keep both lists identical (a unit test compares the strict policy, the script's list and
the table below).

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
| 7 | allow | `api.github.com` | GitHub API for credentialed sandbox traffic. The orchestrator's installation-token mint does not use it: that call goes direct (`docs/network-policy.md`) |
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

`hack/onecli-host-rules.sh`. Dry run by default. (`hack/onecli-bootstrap.sh` does the same for the hosts in `ONECLI_HOSTS`, which has no default.)

```sh
hack/onecli-host-rules.sh            # prints the plan, makes no request
hack/onecli-host-rules.sh --apply    # needs the admin key
```

- Admin key: Secret `secret-store/pi-onecli-admin`, key `api-key`, read with `kubectl` (or `ONECLI_API_KEY`). It goes to
  curl on stdin and is never printed. The orchestrator holds this key too ([ADR 0042](decisions/0042-onecli-admin-key-in-orchestrator.md)); run the
  script from an operator machine only.
- `ONECLI_URL` (required): the OneCLI API base, e.g. `https://onecli.example.com`. Use `http://localhost:10256` with
  `kubectl -n onecli port-forward svc/onecli 10256` if the Cilium ingress policy has closed the route.
- Idempotent by rule name (`pi-allow-<host>`, `pi-block-all`). Adding a host later: add it to `hosts` in the script and to
  `egress-strict.yaml`, rerun; the script creates the missing allow rules first, while `pi-block-all` still exists, then deletes
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

The Cilium FQDN policy on the OneCLI pod (see `hack/onecli-policies/`) is the second layer: a host allowed here but
missing there fails to connect.

(Historical, before the egress proxy.) Sandboxes still reach public hosts directly (`sandbox-allow-internet-egress`, decision 2026-11-15), so this list only
limits what goes through the gateway: model calls and git with injected credentials. Routing sandbox traffic through the
gateway too would need `HTTPS_PROXY` in the sandbox, the OneCLI CA in every tool, and the package hosts each session
needs on this list. It is not done; revisit before real use with untrusted code.

## Rollback (back to the open default)

List rules with `GET /v1/org/policy/rules` and delete `pi-block-all` first (restores relaying of public hosts as in
v2.20.0 defaults), then the `pi-allow-*` rules if wanted. Deleting only the block rule is enough to undo the restriction. Do not
rerun the script or an old bootstrap afterwards: they create the block again.

## Reconciled rules: MCP servers and route=onecli hosts (ADR 0040)

With `PI_ONECLI_HOST_RULES=reconcile` (chart `onecli.hostRules.reconcile`; on in `hack/kind-up.sh --onecli --egress-proxy`) the
orchestrator keeps the gateway's host rules in step with the egress rules, so a host needs no run of the script above:

| Wanted host | From |
|---|---|
| every host of an `allow` rule with `route=onecli` (a rule set, a repo session's rules, an admin's; not expired) | the egress rules (ADR 0034, 0037) |
| every host of an enabled MCP server of the catalog, whatever its route | the system set `mcp-catalog`, derived in the transaction of the catalog write (ADR 0040) |

The reconciler creates one rule `pi-egress-allow-<host>` (`*.suffix` is `pi-egress-allow-wild-suffix`) per wanted host and deletes
the ones nobody wants any more. It runs on every `egress_rules` notification (a catalog PUT is one), on a catalog notification and
every 30 s, serialised across orchestrators by an advisory lock; after a change every MCP server retries its discovery at once.
A catalog PUT is reachable in seconds (live numbers in ADR 0040).

**Ownership.** Only rules named `pi-egress-allow-*` are ever created or deleted. Rules made by hand or by
`hack/onecli-host-rules.sh` (`pi-allow-*`, anything else) are never changed, and a host one of them already covers in front of
the block gets no rule of ours. **The terminal block is the one exception**: the gateway applies rules in creation order (first
match wins; `priority` is not settable), so an allow created behind `block *` is ineffective. When the reconciler adds allows it
recreates the block, same name and body, behind them: the copy is created first and the original deleted second, so the gateway
is never without a block. It never creates a block where there is none (an open install stays open). Do not edit `pi-egress-allow-*` rules by hand: the next
pass puts them back (or removes them).

**Without the reconciler** (the default for a chart install) an MCP catalog row still does not open egress: the host must be
allowed here (a rule in `hack/onecli-host-rules.sh`, applied before the final block rule) and in the orchestrator's egress policy
(`hack/onecli-policies/egress-strict.yaml`). On an open install (no block) none of this applies: the server connects as soon as the
orchestrator can reach it. Until then the server fails to connect: the orchestrator logs `mcp-discovery-failed` with the
retry delay, and calls to its tools settle `tool_unavailable`. The MCP server URL must include the server's MCP endpoint path
(`https://host/mcp`, not the host root); the root answers 404 `Cannot POST /` in the same log line.

The reconciler uses the OneCLI admin key the orchestrator holds for repo sessions; it stays there for the proof of concept
([ADR 0042](decisions/0042-onecli-admin-key-in-orchestrator.md)).
