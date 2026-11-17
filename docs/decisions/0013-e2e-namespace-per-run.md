# 0013: Every e2e run gets its own namespace

Status: accepted, 2026-11-16 (issue #69).

## Context

The suites ran in the long-lived `pi-durable-poc`. Each run pushed code, restarted the shared orchestrator and ingest, changed
the model settings and had to put the base configuration back, so only one run at a time was possible (about 40 minutes
for phases 4, 4b, 4c and 3), live sessions were disturbed, and a failed run left the shared stack in a test state.

## Decision

- **A namespace per run, `pi-e2e-<id>`, with a full stack in it**, applied from the same manifests as production
  (`deploy/` through `tests/e2e/deploy`, a kustomize overlay with `namespace:` set by a generated overlay). Own Postgres
  (the same CNPG manifest), orchestrator, ingest, template, RBAC and network policies. The driver identity and volume
  are in it too. Chosen over templating (`sed`) because kustomize already sets the namespace on every object and on RBAC subjects.
- **Nothing in `deploy/` or `tests/e2e/` names the long-lived namespace** except the defaults of the long-lived
  deployment (`deploy/kustomization.yaml`, `deploy/cilium/kustomization.yaml`, `deploy/namespace.yaml`, `NAMESPACE` default of the
  deploy scripts). The `run-*.sh` scripts have no default at all, and `run.sh` refuses a namespace without the prefix
  `pi-e2e-`, so an e2e run cannot touch `pi-durable-poc` even by a typo. The orchestrator reads its namespace from the downward API.
- **Secrets.** Per-run random `sandboxd-auth` and `api-auth` are generated in the namespace. The credentials of
  OneCLI and GitHub come from the same ExternalSecrets as production: the store is a ClusterSecretStore, so no value is
  copied by hand and none passes through the Mac. The orchestrator reads them once at start, so it starts at 0 replicas and is scaled up after the ExternalSecrets
  are Ready.
- **Cross-namespace pieces by label.** The namespace carries `pi-durable-e2e=true`. The OneCLI ingress policy (argo-c2) admits
  that label; the sweeper selects on it. A label rather than a list of namespace names, because names are random per run.
- **Deletion.** The namespace is deleted at the end (waiting until it is gone), unless `KEEP_NS=1`, or `KEEP_NS_ON_FAIL=1` and the run
  failed, or the Job was left unfinished. `tests/e2e/sweep.sh` deletes `pi-e2e-*` namespaces with the label older than N hours (default 6) and runs at the start of every
  run.
- **Resource requests** of Postgres and the orchestrator are lowered in the e2e overlay (50m / 192Mi); limits are production's.

## Consequences

- Two runs from two branches run at the same time; `pi-durable-poc` is not restarted by any run.
- A run costs about three minutes more for the stack (CNPG start, volumes) and the tear-down than a run in a warm namespace.
- Runs share one OneCLI identity (agent token, management key) with production, the global host rules and the node. Per-session
  agents are named with a per-stack prefix (`PI_ONECLI_NAME_PREFIX`: `pi-session-` for the long-lived stack, `pi-e2e-<run id>-` for a run).
  Without it the collision is real, not hypothetical: each orchestrator's orphan sweep (ADR 0002) revoked the other stack's agents
  as "unknown", sessions failed with `CONNECT rejected: invalid agent token` (407) and phase 4c failed in both stacks. The sweep's
  patterns are anchored at the start, so it judges only its own prefix. A suite that changes OneCLI-global state would still break
  the independence; none does today.
- OneCLI agents and secrets outlive the namespace. A killed or swept run leaves its `pi-e2e-<run id>-*` objects behind, and no later
  stack can sweep them (another prefix). `tests/e2e/sweep.sh` does not remove them (it has no OneCLI key); remove them by hand.
- Until the argo-c2 ingress change is merged, suites that call OneCLI from a run namespace fail (docs/e2e.md).
  (2026-11-17: merged and live; OneCLI admits labelled run namespaces.)
- Cluster-wide pieces (CNPG operator, agent-sandbox controller, ESO) are shared by all runs. The CNPG operator reconciles up to 10 clusters at once.

## Addendum: the shards suite (issue #84)

`tests/e2e/run.sh shards` adds a second orchestrator Deployment (`deploy/add-shard.sh 1`) inside the run's own namespace
to test [0017](0017-schema-sharding.md). It is not part of `all`, and it stays inside the `pi-e2e-<id>` namespace, so the
isolation above holds. Shard claim names are `pi-s<k>-conv-<n>`; the per-stack OneCLI prefix is unchanged.
