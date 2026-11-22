# 0056: Operators define OpenAI-compatible model providers in the chart

Status: accepted, 2026-11-22 (issue #357). Amends [0025](0025-model-catalog.md) (the catalog no longer changes only with a
new image). Related: [0043](0043-open-onecli-defaults.md) (what OneCLI may reach), [0008](0008-settings-in-postgres.md) (the
allowlist), [0017](0017-schema-sharding.md) (shards).

## Context

The model catalog was pi-ai's builtin providers and nothing else. An operator who runs an OpenAI-compatible server (oMLX on
a LAN machine, vLLM, a corporate gateway) could not offer its models to agents. The first concrete user is oMLX at
`http://192.168.7.101:8000/v1`: plain HTTP, an IP address, no key.

Two rules of this project bear on it. Every credential goes through OneCLI (`plan.md`, "Secrets": the orchestrator holds only
a OneCLI agent token). And a base URL decides where model traffic, and with it the conversation, is sent: whoever can set one
can send prompts anywhere the orchestrator can reach.

## Decision

**`models.customProviders[]` in the chart values defines providers; agents pick their models like builtin ones.** Per provider:
`id` (`^[a-z][a-z0-9-]*$`), `baseUrl`, `via`, `models[]` (`id`, `contextWindow`, `maxTokens` required; `name`, `reasoning`
(false) and `input` (`["text"]`) optional; the cost is always 0), and an optional `compat`, a whitelisted subset of pi-ai's
openai-completions flags with `supportsDeveloperRole` and `supportsReasoningEffort` defaulting to false (servers behind an
OpenAI-compatible URL mostly lack both). There is no `/v1/models` discovery: the operator states the limits.

**Two transports**, chosen per provider by `via`:

| | `onecli` (default, the generic path) | `direct` |
|---|---|---|
| For | any HTTPS API with a key | a keyless server on the LAN |
| `baseUrl` | `https://` and a host **name**; an IP address is refused | `http` or `https`, IPv4 address or host name, any port |
| Call | through the OneCLI gateway, like builtin providers; the API key resolves to the existing placeholder and OneCLI injects the secret whose host pattern covers the host | the orchestrator's own `fetch`, no gateway, `redirect: "error"`, only to the origin of its `baseUrl` |
| Credential | an OneCLI generic secret with a `hostPattern` (documented, no code in OneCLI) | none: **keyless only**. Any key, token or header field is refused |
| Network | the gateway's existing egress rule. OneCLI admits private RFC 1918 targets on TCP 443 only ([0043](0043-open-onecli-defaults.md)), so an HTTPS host on a LAN works | a per-provider `egress: { cidr, port }`, rendered by the chart as one `ipBlock` egress rule of the orchestrator |

**Static chart configuration, not an admin API.** The providers are rendered into the ConfigMap `pi-custom-providers`
(`PI_CUSTOM_MODEL_PROVIDERS`, JSON, no secret in it) and read at start by every orchestrator shard. It is one ConfigMap in
every shard's `envFrom`, so all shards install the same providers, and the ConfigMap checksum restarts them on a change.
Reasons: a conversation may run on any shard and resolves its stored `{ provider, modelId }` there, so the shards must agree
(a provider missing on one shard fails the run with `no_model`); the egress rule must be rendered from the same values that
define the provider, or a provider could point at an address the network policy was never opened for; and a base URL that
bypasses OneCLI is exactly what `PUT /admin/settings` and profile writes must not be able to set. The allowlist stays where it
was: the models appear in `GET /admin/models` and are allowed with `PUT /admin/settings`, per session and per profile.

**Installed always, after the builtin providers.** A direct provider is installed even without the OneCLI token (it needs
none, and an allowlisted direct model does not make the token mandatory). A provider through OneCLI is installed with the
builtin ones, when the token is set. A change needs a restart. Removing a provider breaks the stored conversations that name
it at their next turn (`no_model`, [model credentials](../model-credentials.md)); the orchestrator logs a warning at start,
`custom-model-providers`, with ids, transport and model counts and no other value.

**Validation at start (the orchestrator) and at render (the chart).** The start fails on: an id that is a builtin provider,
`scripted` or `faux`; duplicate provider or model ids; a bad id or URL; unknown fields, with a pointer to OneCLI for anything
that looks like a credential; for `onecli`, `http` or an IP literal, and a host that `NO_PROXY` would send around the gateway
(the default list holds only cluster names and the private IP ranges, so a host **name** on a LAN is not caught); for
`direct`, a missing `egress`, a port that is not the URL's, an IP outside the CIDR, loopback names, and any CIDR or address
touching 169.254.0.0/16 (cloud metadata), 100.64.0.0/10 (CGNAT, node networks) or 127.0.0.0/8. The chart enforces the egress
rules itself (`fail`, also under `--skip-schema-validation`), so a bad rule never reaches the cluster.

**The Cilium policies need no change.** They only add allowed destinations to the standard NetworkPolicies, which Cilium also
enforces; the one `ipBlock` rule is enough. An `ipBlock` does not match in-cluster pod addresses, so a provider inside the
cluster is a Service and not a custom provider.

**The catalog hint.** A `direct` provider counts as credential `configured` (there is nothing to be missing), so it shows in
the default `GET /admin/models` view. A provider through OneCLI uses the existing host-pattern matching against its `baseUrl`
host.

## Consequences

- Amends [0025](0025-model-catalog.md): the catalog also changes with the chart values and a restart, not only with a new
  image.
- A `direct` provider is a hole by design, as small as the chart can make it: one address and port for the orchestrator pod
  only; sandboxes are unaffected (they reach the egress proxy and nothing else, [0038](0038-network-modes.md)), and no
  custom-provider configuration is mounted into ingest, a sandbox or a bridge (the relay's environment is an allow list,
  `bridgeEnv`).
- Model traffic to a direct provider is not audited by OneCLI and is plain HTTP when the URL says so. That is the operator's
  trade for a LAN server; the LAN host sees the whole conversation.
- A `direct` provider **with a key** is not part of this decision. It would put a credential outside OneCLI, which `plan.md`
  rules out ("every credential goes through OneCLI"); it needs a new ADR that amends that rule (where the key lives, how it
  stays out of the sandboxes and logs). Until then a keyed server is reached through OneCLI over HTTPS, a LAN server on 443
  included.
- IPv6 literals and IPv6 egress are not supported for `direct`.
