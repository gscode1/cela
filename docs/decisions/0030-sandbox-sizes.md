# 0030: Sandbox sizes

Status: accepted, 2026-11-18 (issue #108). Builds on [0010](0010-session-profiles.md) (profiles) and
[0020](0020-helm-install.md) (the chart).

## Context

Every sandbox got one fixed size from the single SandboxTemplate: 250m CPU and 256Mi memory limits and a 1Gi workspace.
That suits short tool calls, but coding sessions that install toolchains and build a repository run out of disk and time
(2026-11-17: an implementation session filled 86% of its workspace and its Pod was recycled after a slow command). The
lab stack was raised by hand to 2 CPU, 4Gi and 10Gi, outside the repo and for every session.

agent-sandbox v1.0.11's `SandboxClaim.spec` has `env`, `volumeClaimTemplates`, `additionalPodMetadata`, `lifecycle` and
`warmPoolRef`. It cannot change a container's CPU or memory, so a claim cannot pick its size on its own.

## Decision

- **Named sizes, defined by the operator in chart values** (`sandbox.sizes`, a map from name to `resources`,
  `workspaceSize`, `ephemeralStorage` and `warmPoolReplicas`; `sandbox.defaultSize` names one). Defaults: `s` (the old
  fixed size), `m`, `l`, `xl`. A name is 1 to 16 characters of `[a-z0-9-]`, starting with a letter.
- **One SandboxTemplate and one SandboxWarmPool per size**: `pi-env-template-<size>` and `pi-env-pool-<size>`. A claim
  picks its size through `warmPoolRef`. The pool with `replicas: 0` is a plain template alias, as before; each size can
  keep its own warm Pods.
- **The unsized `pi-env-template` and `pi-env-pool` stay**, rendered with the default size. Claims made before sizes
  reference `pi-env-pool`, and the e2e suites create claims on it directly.
- **Not through the admin API.** A size is a cluster object (a template) that the chart owns; creating templates at
  runtime would give ingest or the orchestrator write access to SandboxTemplates. The admin API only lists the sizes
  (`GET /admin/sandbox-sizes`), from the values the chart hands to ingest (`PI_SANDBOX_SIZES`, JSON, and
  `PI_SANDBOX_DEFAULT_SIZE`).
- **Profiles choose, callers pick within that.** A profile may set `sandboxSize` (its sessions' default) and
  `sandboxSizes` (the sizes a caller may ask for). `POST /sessions` takes `sandboxSize`; the session gets the request's
  size, else the profile's, else the deployment default. It must be one of the profile's `sandboxSizes` or that profile
  default, and it must exist in this deployment, or the request is a `400`. A profile without `sandboxSizes` therefore
  lets callers pick nothing but its default. Names are checked against the deployment's sizes when an admin writes a
  version.
- **Stored per session** in `inbox.sessions.sandbox_size` (migration 022) and reported by `GET /sessions/{id}`. The
  orchestrator creates the claim with `warmPoolRef: pi-env-pool-<size>`. A session without a size (older than this) uses
  `pi-env-pool`.

## Consequences

- **A size change does not reach existing sandboxes.** Like any template change ([0019](0019-restricted-pod-security.md)),
  the controller copies the template into the Sandbox when the claim is made. A changed or removed size applies to new
  sessions; a profile snapshot that names a removed size refuses new sessions with a `400` until the profile changes.
- **Moving a session to another size is manual and not offered by the API.** An operator can edit the session's
  Sandbox (`kubectl edit sandbox <claim>`: the Pod's resources) and expand its PVC (online on a storage class with
  `allowVolumeExpansion`); the Pod is then replaced, which ends running commands as a recycle does
  ([0003](0003-recycle-pod-on-interrupt.md)). `inbox.sessions.sandbox_size` keeps the name it was created with.
- The `ephemeralStorage` limit bounds what a sandbox writes outside its workspace (image layers, `/tmp`); a Pod over it
  is evicted and replaced, which the session sees as a lost sandbox.
- Sizes that no node can fit only fail when a session asks for them: the claim then never becomes Ready and the first
  tool call fails after the claim wait. The chart does not check node capacity.

## Rejected

- **Per-claim resource overrides.** Not in agent-sandbox v1.0.11's claim spec.
- **Sizes in Postgres, managed through the admin API.** See above: it needs runtime write access to cluster objects.
- **Free CPU and memory numbers in `POST /sessions`.** Clients must not pick their own limits.
