# 0025: the orchestrator publishes the model catalog, and ingest checks new model settings against it

Status: accepted, 2026-11-17 (issue #152).

## Context

Operators typed `provider/model` strings by hand for the settings' `defaultModel` and `allowlist` and for a profile's
`defaultModel`; a typo was only found at the first turn. The orchestrator already builds pi-ai's catalog (`buildModels`),
and ingest already learns the installed tools from it through `inbox.orchestrator_capabilities` (ADR 0010).

## Decision

- **Publish with the capabilities.** At its start the orchestrator writes the catalog with its tools and extensions: the new
  nullable jsonb columns `models` (`[{ provider, id, name?, reasoning, contextWindow, maxTokens }]`) and `model_providers`
  (`[{ provider, credential }]`), migration 018. `faux` (internal to the /control tests) is left out, `scripted` is in. With
  all builtin providers it is about 1,650 models and 240 KB, which jsonb holds without trouble; it is read only by admin
  requests and by the checks below. Sharding (ADR 0017) changes nothing: the table has one row, every shard publishes with the
  same code, and the last writer wins.
- **`GET /admin/models`** returns the catalog (`source: "orchestrator"`) or an empty one (`source: "none"`). 1,645 models are
  too many to pick from, so the default view never returns a big list: only providers whose credential hint is `configured`,
  `filtered: true`, and never `scripted`, a test provider for CI, e2e and the quickstart that is hidden from the console.
  There is no fallback to the full catalog: `credentials` says why the list is empty, `none-configured` when OneCLI was
  checked and holds no model credential, `unknown` (with a `reason`) when it could not be checked, and the console shows that
  instead of a list. `?all=1` returns the full catalog, `scripted` included. The filter shapes this view only: validation
  below always uses the full catalog.
- **Validation only when a catalog is published.** `PUT /admin/settings` and a profile `PUT` answer `400`, naming the entry,
  for a model the write adds that is not in the catalog. Entries kept from the stored value are not re-checked, so an
  operator can change another field while an old model has left the catalog; nothing is checked on reads, at session creation
  (the allowlist still governs that) or when no catalog is published (an old orchestrator, a first start).
- **The catalog says what pi-ai knows, not which providers have a credential.** The credentials live in OneCLI. The
  orchestrator adds a per provider hint from its OneCLI admin client at its start: `configured` when some secret's
  `hostPattern` covers the provider's base host (the same host, or `*.suffix` for a subdomain; a bare `*` counts for nothing),
  when the provider is `openai-codex` and `PI_CODEX_ACCOUNT_ID` is set, or when it is `scripted`; `missing` when none does;
  `unknown` when there is no admin key or the listing fails (logged, never fatal). The hint is not proof (the key may be
  invalid, the agent may lack the grant); only the first turn proves a credential. It is never used to refuse a model, and it
  depends on the orchestrator's OneCLI admin key, which issue #65 plans to move out; then it will become `unknown` or move
  with the key. It is published at start and refreshed every 30 s (amendment below).

## Consequences

A catalog is as old as the orchestrator process: a pi-ai upgrade shows after the rollout. A secret added to OneCLI shows in the
hint within about 30 s (amendment below). The console can offer pickers and warn on `missing` without a new round trip to the orchestrator.

## Amendment: the credential hint is refreshed without a restart (issue #242)

A Codex login added in OneCLI after the start did not show in the console until the orchestrator restarted. Now shard 0's
orchestrator (the probe shard, when it has a OneCLI admin key) re-lists OneCLI's secrets every 30 s and writes only
`model_providers`, and only when it changed (`publishModelProviders`, a plain `update`: no row before the start publish, so
nothing is written then). One shard writes, so the shards do not fight over the row between starts; the start publish of
every shard still writes it, as before. A failed listing keeps the last hint instead of writing `unknown`, which would empty
the console's model list on every OneCLI blip; at start a failure still gives `unknown`. The catalog itself (`models`) is
still written at start only: it changes only with a new image. The console refetches `GET /admin/models` when its window
regains focus. Cost: one `GET /v1/secrets` every 30 s, the same call the orphan sweep makes. A refresh button was considered
and rejected: it needs a request row, a route and a pickup loop, and the loop alone is enough.
