# 0022: Bundled OneCLI, its bootstrap, and why sign-up stays open

Status: accepted, 2026-11-17 (issue #136, install slice 10). Builds on [0020](0020-helm-install.md) (D4), the spike
[research/onecli-bundled-spike.md](../research/onecli-bundled-spike.md) (#120) and [0019](0019-restricted-pod-security.md).

## Context

`onecli.mode: bundled` was planned in ADR 0020: the upstream OneCLI chart as its own release, with a bootstrap that
creates what an empty OneCLI lacks. The spike found two facts that change the plan's security story:

1. OneCLI's management API (`:10256`) **accepts a sign-up from anyone who can reach it, forever**, and has no switch to
   stop that. Version 2.20.0 says so in its source: `emailAndPassword` has no `disableSignUp`, "registration is open on
   self-host"; no environment variable and no chart value changes it (`maxOrgsPerUser` caps the organizations of one
   user, not the number of users). A second account gets an organization of its own, with its own agents and tokens, and
   **our host rules do not apply to it**: its agents reach the whole internet through our gateway.
2. The gateway honours any organization's agent token.

So "the first account owns the install" (the plan's earlier sentence) is false, and the bootstrap cannot be a lock.

## Decision

- **Sign-up is not closed; the network is the control.** OneCLI has no supported way to close it. We do not patch the
  image, proxy `/auth/*` in front of the API, or delete users, because each of those is a fork to maintain. What we do:
  the API and the dashboard are ClusterIP only, with no Ingress or HTTPRoute (the upstream chart's `ingress` and
  `httpRoute` are off in `charts/pi-onecli/upstream-values.yaml`, and a test asserts it). `charts/pi-onecli` denies all
  ingress and egress to the OneCLI pods first, then admits the API (`:10256`) only from the orchestrator, a pod labelled
  `app.kubernetes.io/name=pi-onecli-bootstrap`, and OneCLI's own dashboard and gateway; the gateway (`:10255`) from
  sandboxes and the orchestrator; and the dashboard from nobody. `hack/kind-smoke.sh --onecli` checks it live: the
  orchestrator reaches the API, ingest and a sandbox do not. **Residual risk:** anyone who can reach the API, for example
  a pod in the namespace that the policies do not select or a cluster without an enforcing CNI, can still claim an
  organization and use the gateway as an open proxy. Report upstream (a `DISABLE_SIGNUP` switch). Exposing the dashboard
  on purpose needs a route that returns 403 for `/auth/signup` and `/auth/sign-up*` (docs/model-credentials.md).
- **`onecli.mode: bundled` in the app chart**, not "external pointing at the bundled release". The chart derives from
  one place (`onecli.bundled`: release, and the names of the token Secret, admin-key Secret and CA ConfigMap that the
  bootstrap writes) the URLs, the network policy peers, the Secret references and the CA mount, so the two sides cannot
  drift. In bundled mode those references are required, not optional: the orchestrator fails to start if the bootstrap
  did not run, instead of silently starting with no OneCLI. External mode is unchanged.
- **Three releases, one command.** `hack/onecli.sh` (called by `hack/install.sh` when the rendered chart says bundled, and
  so by `hack/kind-up.sh --onecli`) creates `onecli-database` and `onecli-secrets` once (never regenerated), installs
  `charts/pi-onecli` (policies, first), installs the upstream chart as release `onecli`, then runs
  `hack/onecli-bootstrap.sh`. The policies are their own chart, not part of `pi-durable`, because they must exist before the
  OneCLI pods do and `pi-durable` is installed after the bootstrap (the orchestrator reads the token and CA at start).
- **Pins.** Upstream chart `oci://ghcr.io/onecli/charts/onecli` version `2.20.0`, manifest digest
  `sha256:0e67ea2b3311ff30868b851dc2e5622f6febd8a82855fed8fb9524e3522063ba` (in `hack/onecli.sh`). The chart takes its image
  tags from `appVersion`; it cannot pin a digest per image, so the images are pinned by tag only. A bump needs the
  bootstrap run against the new version: it depends on observed behaviour (the first `/v1` call of a session must be
  `GET /v1/auth/session`, and `Origin` must equal `externalUrl`) and fails loudly when that changes.
- **The bootstrap runs on the operator's machine through `kubectl port-forward`.** The forward is made by the kubelet and
  is not a pod-to-pod connection, so no policy entry is needed. A Job variant is possible (`ONECLI_API_URL`,
  `ONECLI_EXTERNAL_URL`, a pod labelled `pi-onecli-bootstrap`, which the policies already admit) and not built.
- **Idempotent by lookup, not by the API.** OneCLI answers 409 for a duplicate agent but silently creates duplicate
  secrets and rules, so the script finds by name or identifier first, stores the account password before it signs up (a
  crash must not leave an owned account with a lost password), and skips every auth call when the stored admin key still
  works (auth is rate limited). It counts its writes and ends with `done: changed=N`; a second run prints `changed=0`.
  Run it once at a time.
- **Secrets.** `pi-onecli-admin` (`email`, `password`, `api-key`) is the dashboard login and the account-level admin key;
  `pi-onecli` (`agent-token`) is the orchestrator's token. The chart gives the orchestrator single keys by `secretKeyRef`,
  so the login password never reaches a pod. Nothing prints a value. The CA ConfigMap `pi-onecli-ca` (key `ca.pem`) holds
  only the public certificate; the script refuses a PEM with a private key.
- **`deploy/fetch-onecli-ca.sh` stays** for an external OneCLI and for the `deploy/` stack and e2e, which do not run the
  bootstrap. Chart installs with a bundled OneCLI do not use it.

## Consequences

- A bundled OneCLI trial exists on kind in about 5 minutes, with the dashboard reachable by port-forward and a host
  allowlist already in place.
- Without a CNI that enforces NetworkPolicy the API is open to every pod. The isolation probe reports that state for
  sandboxes; the OneCLI policies share the same dependency.
- `helm uninstall onecli` keeps `onecli-gateway-ca` and `onecli-secrets` (the CA Job and the secrets are not Helm
  resources). That keeps existing sandbox trust and the encryption key; remove them on purpose with the namespace.
- The admin key is account-level; OneCLI has no scoped key type, so the orchestrator still holds an admin key to create
  per-session agents (as in ADR 0020).

## Not verified

A real model call and a Codex login through the bundled gateway; OAuth and GitHub App flows against a real provider;
`database.external` with TLS; Cilium; an upgrade of the upstream chart; the bootstrap as a Job.

## Addendum: kind publishes the dashboard and API on localhost (issue #138)

Decision: on kind only, `hack/kind-up.sh` publishes the session API and the bundled OneCLI dashboard and API on the
host's loopback (`localhost:8080`, `:10254`, `:10256`) instead of needing `kubectl port-forward`. `--no-expose` opts out. This
changes the Consequences above (the dashboard was reachable by port-forward only) for kind and for nothing else.

- **Mechanism.** kind `extraPortMappings` bound to `127.0.0.1` (created with the cluster; a reused cluster without them is
  refused, with the fix), NodePort Services with `externalTrafficPolicy: Local` (`ingest.expose` in `charts/pi-durable`,
  `expose` in `charts/pi-onecli`, both off by default, so real-cluster renders are unchanged), and exactly one extra
  ingress source: an `ipBlock` /32. The host ports are fixed because `externalUrl` is `http://localhost:10254` and the
  dashboard calls the API at `localhost:10256`.
- **The source address was measured, not assumed.** On Docker Desktop for Mac (kind v0.33, kindnet, node image 1.37) a
  `curl localhost:<port>` arrives at the pod as the IPv4 gateway of the Docker network `kind` (`172.20.0.1`), with
  `externalTrafficPolicy: Local`. Without Local the address would be rewritten. The rule is that /32, never the node IP and
  never the subnet: a sandbox can reach the node and the subnet, and the management API takes a sign-up from whoever
  reaches it. The schemas reject any value that is not an IPv4 /32.
- **Check.** `hack/kind-smoke.sh` calls the three ports from the host, and, from a real sandbox, expects the node IP on
  each NodePort and each ClusterIP to be blocked.
- **Residual risk (kind only, unchanged by this).** kindnet does not filter traffic to the node itself, so a sandbox can
  still reach the API server, kubelet and etcd ports without credentials (`automountServiceAccountToken` is false). Only an
  enforcing CNI such as Cilium closes that (issue #139). If the Docker network's gateway were not where host connections arrive from
  on another platform, the install would not be reachable on localhost; it would not become more open, because the rule
  names one address.

