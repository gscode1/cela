# 0035: The egress proxy at runtime: rules from Postgres, address safety, status

Status: accepted, 2026-11-18 (slice 3 of epic #50, issue #248). Builds on [0012](0012-egress-proxy-spike.md) (the Go
proxy, Smokescreen, the tunnel registry) and [0034](0034-egress-rules.md) (rule sets, precedence, the private tier).

## Context

Slice 2 stored the rules and the admin API; the proxy of the spike still read a static file. This slice makes the proxy
read the same rows, judge every connection with the same evaluator, enforce the address tiers of 0034 on the resolved
address, and report what it serves. Nothing sends sandbox traffic to it yet (`egressProxy.enabled` is off by default):
per-session principals are slice 4, the OneCLI route 5, the network cutover 6, tunnel revocation 7.

## Decision

### Snapshot delivery and fail-closed timing

- One statement reads `max(egress.revisions.revision)`, `egress.rule_sets` and `egress.rules` as JSON, so a snapshot is
  consistent. Rows that fail the rule shape checks are counted and left out (as `explain` does), not fatal.
- A **reload** happens on `LISTEN egress_rules` (the admin API notifies in the write's transaction) and on a **5 s poll**
  (`egressProxy.rules.pollInterval`), which also covers a missed notification or a listener that is reconnecting. A change
  therefore reaches a replica in well under a second normally and within about 5 s at worst.
- **Never serve before the first read.** The proxy port is opened only after the first successful read of the rules and of
  the platform addresses; until then the pod is not Ready (`/readyz` on :3130) and connections are refused.
- **Fail closed.** After `egressProxy.rules.staleAfter` (default **2 min**) without a successful read every connection is
  denied with a reason that says the rules are unavailable. The pod stays Ready (a refusal at the TCP level would hide
  why). Tunnels that are already open are not closed by this (slice 7 owns revocation); they end at idle time or the
  maximum age. A read that hangs is cut after 4 s so the poll goes on.
- **Evaluator parity.** `evaluateEgress` (TypeScript) and `Evaluate` (Go) return the same decision, route, matched rule and
  a `reasonKind` word, pinned by `packages/session-core/test/egress-vectors.json`; both test suites run all vectors. A change
  to the rules of evaluation changes the vectors first.

### Addresses: resolve, judge, dial the checked IP

The ACL decision does three things. It judges the **name** (no rule names it: deny, no DNS lookup, so the proxy is not a DNS
oracle). It then resolves the host and judges **every address** (always-blocked ranges, the platform block list, then the
private tier by `private: true` rules), exactly as `Evaluate` does with `addresses`. The direct route then **dials the first
address that was judged**: Smokescreen's `dialContext` reuses the resolved address of the decision, so there is no second
lookup that attacker-controlled DNS could answer differently (rebinding). Smokescreen's own classification stays as a second
layer for loopback, link-local, multicast and reserved addresses; private, ULA and CGNAT ranges are opened to the evaluator
(`OpenPrivateRanges`) because the evaluator, with the platform list, is the authority for them. IP literals are never a rule
host and are denied.

### The platform block list (no rule can open it)

The proxy has no Kubernetes API token, so the list comes from configuration the chart renders, not from a lookup of Pods:

1. **Names** (`EGRESS_PLATFORM_HOSTS`), resolved at start and every 30 s: `pi-ingest`, every `pi-orchestrator[-N]`, the
   OneCLI API and gateway hosts when OneCLI is in the cluster, `kubernetes.default.svc`, plus `egressProxy.platform.hosts`.
2. **Added by the proxy itself:** the host of its own database URI (Postgres) and `KUBERNETES_SERVICE_HOST` (the API's
   ClusterIP, in every Pod's environment).
3. **Cidrs** (`EGRESS_PLATFORM_CIDRS`): `egressProxy.platform.cidrs`, `networkPolicy.kubeApiCidrs` (the API server's real
   addresses) and `database.external.egress.cidrs`.

A name that has never resolved keeps the proxy from becoming ready; one that resolved before keeps its last addresses when
DNS fails. **Limit, stated plainly:** Service ClusterIPs are covered exactly, but Pod addresses are not enumerated. A pod is
reachable only if a private rule and `egressProxy.privateEgress` both admit a range that contains it, so an operator who
approves a range that contains the platform's pods puts the pod range in `platform.cidrs`. The network layer is the second
barrier: the proxy's NetworkPolicy reaches only the public internet, the database and `privateEgress`.

### Principal in this slice

A request without a principal is anonymous: judged with no session and no profile, so only rule sets with `applies_to_all`
apply. `Build` takes an optional `Principals`; slice 4 supplies one (token to session and profile rule sets) and nothing
else in the decision changes. `Proxy-Authorization` is ignored without it. The Smokescreen role is the session id, or
`anonymous`.

### Direct route only

A rule that selects `route: onecli` is a deny with "the onecli route arrives in slice 5": the proxy has no upstream
(`EGRESS_UPSTREAM_ADDR` is empty). The chaining code of the spike stays and keeps its tests; it is simply unreachable.

### Read-only database role

CREATE ROLE needs CREATEROLE, which the app's database user does not have (`pi` owns its database but is `NOCREATEROLE`).
So the **operator creates the role** and migration `025_egress_proxy.sql` provides `egress.grant_proxy_reader(role)`, which
grants `usage` on the schema, `select` on `revisions`, `rule_sets` and `rules`, and `select, insert, update, delete` on
`egress.proxy_status` only. The migration applies it to a role named `pi_egress` when that exists; any other name, or a role
created later, is granted by `select egress.grant_proxy_reader('<role>')` as the app's user (the owner). The bundled Postgres
creates the role with `auth.egressReader.enabled` and grants it from its init sidecar. The chart takes the role's URI from
`egressProxy.database.existingSecret`; the proxy never gets write access to a rule, and the same TLS variables as the app
([database-tls](../database-tls.md)) apply.

### Status

Each replica upserts one row in `egress.proxy_status` every 5 s (name, revision, state `starting|serving|stale`, last
successful read, start time, version) and deletes rows silent for 10 minutes. `GET /admin/egress/status` returns them as
`proxy.replicas` (same envelope as before; entries gained `state`, `lastReadAt`, `startedAt`, `updatedAt`, `version`), with
`state: silent` for a replica that has not reported for 30 s (database clock). A table was chosen over scraping the Pods
because ingest has no Kubernetes access and the proxy already holds a database connection. A dead database means no status
row is written; the replica shows silent, which is itself the signal.

### Chart

`egressProxy` (off by default): 2 replicas with anti-affinity and a PodDisruptionBudget (`minAvailable: 1`), a Service on 3128,
a ServiceAccount without a token, restricted Pod Security, probes on :3130. Policies: ingress from sandboxes and
`egressProxy.clients`; egress to the database, to the public internet on `egressProxy.publicPorts` (default 80 and 443) minus
the private, CGNAT, link-local and loopback ranges, DNS (the namespace baseline), and `egressProxy.privateEgress`: each entry
a `cidr` or `namespaceSelector` (with an optional `podSelector`) and explicit `ports`. A private rule in the database opens a
destination only inside that list. Plain NetworkPolicy suffices on both providers, so there is no Cilium variant; Cilium does
not match cluster addresses with a cidr, so use selectors there.

## Consequences

- A stale proxy denies new connections but does not cut open tunnels.
- Pods of the platform are protected by the private tier, the network layer and `platform.cidrs`, not by exact lookup.
- Operators create one database role; the bundled Postgres does it for them.
- The proxy image joins `images/build.sh` and the images workflow; `hack/kind-up.sh --egress-proxy` and
  `hack/egress-smoke.sh` give a repeatable live check.
