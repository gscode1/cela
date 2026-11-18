# Roadmap

Status: **draft, 2026-11-18, not accepted** (issue #233). Until it is accepted, [plan.md](../plan.md) stays the
reference for goal, decisions and phase results. Section 4 lists the decisions that are the owner's to make; the
milestones assume the recommended answer to each.

This page says what comes after the proof of concept. plan.md says what was built and why; this page says what is next,
in which order, and how we know each step is done.

## 1. What the project is now

plan.md calls the project a proof of concept and lists a web console as out of scope. The code has moved past that:
an admin console, session profiles, skills, a model catalog, token budgets, sandbox sizes and an MCP adapter are
features of a platform, not of a spike. The plan should say so, because the label decides what work is worth doing.

Proposed statement (decision D1):

> pi-durable-k8s lets one team run durable coding agents on its own Kubernetes cluster, on its own private
> repositories, with its own model subscriptions. The same team operates it.

That statement sets the priorities below. One team on private repositories makes data leaving the sandbox the main
risk (milestone 3). "Operates it" needs metrics, backups and releases (milestone 4). It does not need active/active
orchestration, a public multi-tenant service or billing (section 5).

## 2. Where it stands (2026-11-18)

| Area | State | Source |
| --- | --- | --- |
| Core path | Phases 1 to 4c done: durable sessions, gVisor sandbox, session API, credentials through OneCLI, repo workspaces | plan.md |
| Install | Helm charts, `hack/install.sh`, kind in one command; kind smoke runs on every pull request | [install plan](install-plan.md) |
| Open defects | 8 bugs (#198 to #201, #208, #210, #212, #214) and one docs-drift issue (#215). Of the 18 filed from #197 on, 10 are fixed; most were in the inbox, turn limits, deletion and the bridge | issue list |
| Open pull requests | 4: #221, #227, #228, #229 close 5 of the 8 open bugs. No pull request yet for #198, #201, #214, #215 | pull request list |
| CI | `pnpm check`, image builds, kind smoke on runc and kindnet. No scheduled workflow: gVisor, Cilium isolation and the full e2e suites run by hand on one lab cluster | `.github/workflows/` |
| Sandbox egress | Open public internet. The egress proxy is built and tested locally, not deployed | [ADR 0012](decisions/0012-egress-proxy-spike.md), #47, #50 |
| Availability | One replica per shard, `Recreate`; a session never moves; the shard count never decreases | [scaling](scaling.md) |
| Start latency | Cold sandbox to first command: p50 20.6 s, p90 30.0 s, from 5 samples | [metrics](metrics.md) |
| Observability | JSON log lines and `measure-timing.mjs`; no metrics endpoint, no tracing | [metrics](metrics.md) |
| Identity and limits | Static tokens in a Secret; no rate limits, quotas or token scopes; no `GET /sessions` | [session API](session-api.md) |
| Upstream | Adapter: our fork, published as `@gscode1/pi-durable-postgres` and pinned to 0.3.0 ([ADR 0033](decisions/0033-own-adapter-package.md); the upstream proposal j-koester/pi-durable-postgres#20 has no review); agent-sandbox SDK vendored; Pi Durable pinned at 1.5.2, the latest release | plan.md, ADR 0033 |
| Releases | No tags, no changelog; packages at 0.0.0, charts at 0.1.0 | repository |

## 3. Milestones

In order. A milestone starts when the one before it is done, except where noted. Each item still follows AGENT.md:
issue, branch, `pnpm check`, pull request.

### Milestone 1: A stable session lifecycle

The bugs filed since #197 cluster in one place: the inbox loop, turn-limit admission, deletion and the exec-in-flight
marker. That pattern says the lifecycle is under-specified, so more point fixes will keep finding more races.

- Merge or close the 4 open pull requests before any new feature, and keep the queue short: on the morning of
  2026-11-18 it held 15, several touching the same files.
- Fix the four issues without a pull request: #198, #201, #214, #215.
- Write the session lifecycle down as one state machine (states, inputs, allowed transitions) in `docs/`, and test it
  as a model: generated sequences of message, steer, delete, restart and transient database failure against the real
  inbox code, checking invariants after each step. Examples: a deleting session never starts a run; a turn limit is
  never exceeded; an input is applied at most once.
- **Done when:** no open issue labelled `bug` is older than a week; the model test runs in `pnpm check` and fails on
  the code as it was before #219 and #226 (proof that it finds this class of bug).

### Milestone 2: CI proves what the README claims

The README's security model rests on gVisor and enforced network policy. CI tests neither.

- A scheduled workflow: kind with Cilium, bundled OneCLI, the `all` and `shards` suites
  ([install plan](install-plan.md), section 8 names this lane; it does not exist yet).
- The isolation suite must fail the run when policy is not enforced (`NETPOL_ENFORCED=1`).
- A gVisor lane, on kind if it can be made to work, otherwise on a small self-hosted runner. The install plan deferred
  this; without it no automated test runs under the real runtime.
- The Pi Durable env and storage conformance suites as CI jobs, so a dependency bump shows its effect before merge.
- A weekly canary job that runs conformance against the newest Pi Durable release and opens an issue when it fails.
- Can run in parallel with milestone 1.
- **Done when:** a pull request that removes a network policy or the gVisor RuntimeClass turns a scheduled run red, and
  the run's result is visible on the repository.

### Milestone 3: Sandbox egress is contained

A sandbox on a private repository has open internet today. An agent that reads a hostile page or issue can be told to
send the repository anywhere. For the statement in section 1, this is the main gap.

- Gateway-only egress for sandboxes (#47), with rules in Postgres (#50). The egress proxy spike is the first slice.
- Egress modes per session profile: at least `open` (today) and `allowlist`. Package registries are on the default
  allowlist so installs keep working (decision D2).
- Move OneCLI provisioning and its admin key out of the orchestrator (#65).
- Per-session gateway identity for credentialed MCP (#42).
- Configurable exceptions for public cluster endpoints (#198) and the kind node exposure (#139).
- **Done when:** an e2e test in an `allowlist` session fails to reach an unlisted public host, still clones, pushes
  and installs a package, and the denied attempt appears in a log an operator can read.

### Milestone 4: Operable by someone who did not build it

- **Metrics:** a Prometheus endpoint on the orchestrator and ingest for what scaling.md asks operators to watch by
  hand: open bridges against the cap, cap wait, inbox depth and age, claim time, run outcomes, token use. Keep the JSON
  timing lines; they stay the detailed record.
- **Tracing:** one trace id from the ingest request through the inbox row to the tool call, in the log lines first,
  OpenTelemetry later if needed.
- **Backup and restore:** a documented procedure for the database, the sandboxd master key and OneCLI's encryption key,
  and a restore test that proves a session resumes afterwards.
- **Upgrades:** a documented upgrade path with a pre-upgrade backup, because state migrations have no rollback.
- **Releases:** tag `v0.1.0`, a changelog, the charts published as OCI artifacts, a `SECURITY.md`.
- **Retention:** the maintenance job for deleted sessions' conversation state, and caps on stored tool output.
- **Done when:** a second person installs a tagged release on a fresh cluster from the docs alone, restores a backup
  into it, and finds the saturation signals on a dashboard.

### Milestone 5: Identity and limits

- OIDC behind the existing `Authenticator` (the session API doc notes this is one function), with static tokens kept
  for automation.
- Per-owner limits: concurrent sessions, sandbox size, token budget, repositories. The repo allowlist of [ADR 0032](decisions/0032-repo-allowlist.md) is
  global; this makes it per owner.
- `GET /sessions` for an owner, so a lost session id no longer leaks a running sandbox
  ([MCP adapter](mcp-adapter.md), limits).
- Request rate limits and a body read deadline at ingest (#201).
- **Done when:** two owners with different limits are enforced in an e2e test, and an owner can list and delete every
  session they own.

### Milestone 6: Availability and start latency

Both need a target before any work (decision D3). The work below is spikes first.

- **Standby spike:** a second orchestrator replica per shard that waits on the storage lock. plan.md's double-owner
  test shows the waiting already works; the open questions are takeover time, and what the in-process broker and open
  bridges do at takeover.
- **Shard drain:** move or finish a shard's sessions so the shard count can decrease.
- **Start latency:** measure the readiness probe period (#82), then decide between a warm pool with late workspace
  attach, pre-provisioned workspaces, or memory-preserving resume (#61). Suspend on process quiescence (#60) belongs
  here too.
- **Done when:** the targets from D3 are written in [scaling](scaling.md) and measured by a suite, with enough samples
  to report a p90.

### Milestone 7: Upstream and reuse

Runs alongside the others; none of it blocks them.

- **Postgres adapter:** decided (D4). The fork publishes `@gscode1/pi-durable-postgres` and this repo pins an exact
  version ([ADR 0033](decisions/0033-own-adapter-package.md)). What remains is upkeep: a fork release for each Pi Durable upgrade, gated by the conformance
  suite, and CI on the fork itself.
- **`sandbox-env` as its own package:** plan.md already names it the piece most useful to others.
- **agent-sandbox:** the "orchestrator outside, tools inside" example (plan.md, phase 5), and a check for an official
  versioned TypeScript SDK that could replace the vendored copy.
- **MCP adapter:** tasks mode once the SDK ships it ([ADR 0031](decisions/0031-mcp-adapter.md)); a remote endpoint.
- **Browser profile** (#48), after milestone 3: a real browser in a sandbox makes egress control more important.

## 4. Decisions to confirm

| | Decision | Recommendation |
| --- | --- | --- |
| D1 | What the project is, and for whom | The statement in section 1: one team, own cluster, private repositories, self-operated |
| D2 | Default egress mode once milestone 3 lands | `allowlist` for repository sessions, `open` for sessions without a repository |
| D3 | Availability and start-latency targets | Set them after the standby spike and the #82 measurement, not before; no number is proposed here |
| D4 | Deadline for the upstream adapter review | **Decided 2026-11-18:** no wait. The fork is published to npm under our own name ([ADR 0033](decisions/0033-own-adapter-package.md)); the upstream pull request stays open |
| D5 | Feature freeze during milestone 1 | Yes, except fixes and milestone 2 |
| D6 | What happens to plan.md | Keep goal, decisions, architecture, risks and layout; move the phase results to [lab notes](lab-notes.md); link here for what is next. AGENT.md's "read plan.md first" then also names this page |

## 5. Not planned

- Active/active orchestration. One owner per schema stays; availability comes from a standby, capacity from shards.
- A public multi-tenant service: sign-up, billing, isolation between tenants that distrust each other.
- Agent runtimes other than Pi Durable.
- An own credential store. Credentials stay in OneCLI ([model credentials](model-credentials.md)).
- More than one cluster.

## 6. Keeping this page true

- A milestone's pull requests update its section: what is done, with the date and the issue.
- A new decision goes to `docs/decisions/` in the pull request that implements it, as today.
- A measured number is quoted with its date and sample size, and lives in [metrics](metrics.md) or
  [lab notes](lab-notes.md); this page links to it.
- When this page and plan.md disagree after acceptance, this page wins for what is next and plan.md for what was
  decided.
