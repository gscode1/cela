# 0064: Sandbox runtimes: a profile picks one of the operator's named runtimes

Status: accepted, 2026-11-23 (issue #406). Amends [0020](0020-helm-install.md) (the runtime guard). Builds on
[0010](0010-session-profiles.md) (profiles, admin-only writes), [0019](0019-restricted-pod-security.md),
[0030](0030-sandbox-sizes.md) and [0038](0038-network-modes.md) (a template and a pool per dimension; the pool is the
choice) and [0041](0041-browser-sandbox.md) (flavours).

## Context

Every sandbox ran under one RuntimeClass, `sandbox.runtimeClassName` (`gvisor`), and the chart refused anything else
without `security.allowInsecureRuntime`. Some workloads need another runtime: a gVisor variant (`gvisor-kvm`), or plain
runc for code that gVisor cannot run. Switching the whole install to runc to serve those would give up isolation for every
session. The runtime has to be a per-session choice made by the operator's profiles, like the network mode (ADR 0038).

## Decision

### The default runtime stays; named runtimes are added

`sandbox.runtimeClassName` with `security.allowInsecureRuntime` is the **default runtime**, unchanged and permanent. In the
API it is called `default`. A session without a choice uses it, and an install with `sandbox.runtimes: {}` (the default)
renders what it rendered before, apart from one label (below). There is no `defaultRuntime` key: Helm cannot tell a legacy
key left at its default from one that was set, and it merges maps, so a second way to name the default would break old
values files.

`sandbox.runtimes` adds named runtimes:

```yaml
sandbox:
  runtimeClassName: gvisor
  runtimes:
    gvisorkvm: { runtimeClassName: gvisor-kvm, flavours: [default, browser] }
    runc: { runtimeClassName: runc-insecure, allowInsecureRuntime: true, flavours: [default, browser] }
```

An entry is `{ runtimeClassName, allowInsecureRuntime (default false), flavours (default [default]) }`. The profile field
`sandboxRuntime` names one; a `POST /sessions` body never does (as with `networkMode`). The runtime is fixed when the
session is created and stored in `inbox.sessions.sandbox_runtime` (null is the default runtime).

### Names

- Runtime name: `^[a-z][a-z0-9]{0,15}$`, no hyphen (so `x-browser` cannot be runtime `x` plus a flavour). Reserved:
  `default`, `browser`, `direct`, `pool`, `template`, `rt`.
- Templates and pools: `pi-env[-rt-<runtime>][-browser][-direct]-template|pool[-<size>]`. The default runtime has no `-rt-`
  infix, so every existing name and claim stays valid. `warmPoolFor(base, size, mode, flavour, runtime)` stays one pure
  function; `null` is the default runtime.
- Label `pi-durable.dev/sandbox-runtime: <name|default>` on every SandboxTemplate, SandboxWarmPool and pod template, the
  default runtime's included. This is the one change to the output of an install without named runtimes.
- A named runtime renders the **proxied** mode only: no `direct` twin in v1 (ingest refuses `sandboxRuntime` with
  `networkMode: direct`). Per runtime and listed flavour that is 5 templates and 5 pools, all with `replicas: 0`.

### The acknowledgements

"gVisor" is a naming convention: a RuntimeClass called `gvisor` or `gvisor-<anything>`. Any other class needs **that
entry's own** `allowInsecureRuntime: true`. `security.allowInsecureRuntime` covers the default runtime only: someone who
accepted runc for the default did not accept it for a runtime they never named. The rule is in the schema (`if/then`) and
repeated in `cela.validate`, so it holds under `--skip-schema-validation`, together with: every listed flavour is enabled,
the class is not empty, the name is neither reserved nor hyphenated. NOTES.txt warns once per insecure runtime. The
orchestrator gets `PI_SANDBOX_RUNTIMES` (JSON: class, `insecure`, flavours per name; ingest gets it too) and
`PI_ALLOW_INSECURE_RUNTIMES` (names with an ack). `PI_ALLOW_INSECURE_RUNTIME=1` covers the default runtime only.

At start the orchestrator lists the chart-labelled SandboxTemplates once, groups them by the runtime label and refuses to
run when one label has two classes or a non-gVisor class has no ack (the Role gains `list` on `sandboxtemplates`). A session
whose runtime is no longer configured fails the attach with `sandbox-runtime-not-configured`; it never falls back to the
default runtime, which would be a silent downgrade.

### Credentials are allowed on any runtime

A repo, a OneCLI route or a credentialed MCP server works under every runtime. Credentials never enter the sandbox (the
egress proxy and the orchestrator hold them), so the runtime does not change what a sandbox can leak. What runc changes is
node co-tenancy: the agent's code shares the node kernel with other Pods. The mitigation is the RuntimeClass's, not the
chart's: give an insecure runtime's RuntimeClass `scheduling.nodeSelector` and `tolerations` onto tainted nodes that run
nothing else. The chart cannot check this; NOTES.txt and the chart README say it.

## Limits and gaps

- **The isolation probe runs under the default runtime only.** `GET /admin/status` reports the probe's result for that
  runtime; a tainted node pool may lack the CNI agent, so NetworkPolicies could be unenforced there and nothing checks it.
- **No per-principal profile allowlist** (ADR 0010, "Not done"). Profile writes are admin-only, but every token holder can
  start a session from any profile, so any of them can start one on the runc profile. Until a per-principal allowlist
  exists, treat an insecure runtime as available to everyone with a token.
- The chart does not check that a RuntimeClass exists. A missing one shows as Pods that do not start.

## Follow-ups (not in this change)

- A per-runtime isolation probe.
- A check that the RuntimeClass schedules onto the nodes it should, and that insecure ones are tainted.
- A direct mode for named runtimes.
- A console badge for the session's runtime.
- An e2e suite with a second runtime.
- A per-principal profile allowlist (ADR 0010).
