# 0042: The OneCLI admin key and the GitHub App key stay in the orchestrator (accepted risk for the proof of concept)

Status: accepted, 2026-11-19 (issue #65). Amends [plan.md](../../plan.md) "Least privilege for OneCLI" and the "moves with
#65" notes in [0025](0025-model-catalog.md) and [0040](0040-mcp-egress-flow.md). Related: [0022](0022-bundled-onecli.md)
(bundled OneCLI, the admin key), [0037](0037-egress-onecli-route.md) (the egress proxy gets no admin key).

## Context

plan.md asked for "a project-scoped OneCLI key or a separate provisioner, never an admin key in the orchestrator".
OneCLI v2.20.0 has no scoped key type ([research](../research/onecli-v2-recheck.md)), and its account-level key can list
every agent's token (`GET /v1/agents`) and edit every secret, grant and host rule. So the only way to meet the plan is
a separate provisioner service that holds the key and does the orchestrator's OneCLI work for it.

The orchestrator uses the admin key for four things: per-session agents, secrets and grants for repository sessions
(`repo-access.ts`) and for credentialed MCP servers (`mcp-access.ts`), the host-rule reconciler (0040), and the
credential hint of the model catalog (0025).

## Decision

**The orchestrator keeps the OneCLI admin key (`ONECLI_API_KEY`) and the GitHub App private key. No provisioner is
built for the proof of concept.** The risk is accepted and recorded here instead.

Why:

- **Moving the admin key barely shrinks what a compromised orchestrator can do.** It would still hold the GitHub App
  private key (it can mint an installation token for any repository the App is installed on), the sandbox master key
  (it can reach every sandbox), its own OneCLI agent token with the model grants, and its Postgres role with the binding
  seal key (0037). The admin key adds listing every agent token and editing secrets, grants and host rules.
- **A provisioner would mostly be a confused deputy.** The orchestrator legitimately creates agents, grants and rotates
  secrets, deletes them and reconciles host rules. A compromised orchestrator would ask the provisioner for the same
  things. What it could refuse (listing tokens, arbitrary host rules) is narrow.
- **The orchestrator is not where untrusted code runs.** Model-generated commands run in gVisor sandboxes, which cannot
  reach the orchestrator, the database or OneCLI's API ([network policy](../network-policy.md)). OneCLI's API port is
  open to the orchestrator only.
- **The cost is high.** A new Deployment, service-to-service authentication, network policies, chart values, e2e
  coverage and one more component that can fail at session start and on the token renewal.
- **Moving the key into an existing component is worse.** Ingest faces clients and the egress proxy faces sandbox
  traffic; 0037 already refused the proxy the key.

What holds:

- Only the orchestrator Deployment gets the admin key; no other workload or sandbox template references it
  (`packages/orchestrator/test/pi-durable-chart.test.ts`, "gives the OneCLI admin key to the orchestrator only").
- The key is optional: without `adminKeySecret` the features above are off (repository sessions are refused, a
  credentialed MCP server is unavailable, the reconciler does not run, the credential hint is `unknown`).
- Operators should treat the orchestrator as holding admin access to OneCLI and the GitHub App: restrict who can exec
  into it or read its Secrets, and keep its image and dependencies pinned.

## Revisit when

- OneCLI ships a scoped key type (per project, or limited to creating and deleting agents and grants it owns), or
- the project moves past the proof of concept to real multi-tenant use, where a compromised orchestrator must not be
  able to read other tenants' tokens.

Then a provisioner (or the scoped key) should take both keys: moving only the OneCLI key would leave the GitHub App key.

## Consequences

- plan.md's "never an admin key in the orchestrator" is changed to point here.
- The "moves with #65" notes in 0025, 0040, docs/repo-workspace.md and docs/onecli-host-rules.md now point here.
- Issue #65 is closed by this ADR.
