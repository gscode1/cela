# 0047: Rename the project to cela

Status: accepted, 2026-11-20 (issue #251).

## Context

The project was called `pi-durable-k8s`, with the chart `pi-durable` and the namespaces `pi-durable-poc` and `pi-durable-e2e`.
That name borrows the upstream product's name (Pi Durable), says nothing about what this project adds, and made it hard to
tell "the upstream framework" from "this project" in code, docs and commands. The owner chose a new name.

## Decision

- **Name:** `cela`. It is Polish for a *cage*, a locked cell: every session runs locked in its own sandbox.
- **Mapping:**
  - npm scope `@pi-durable-k8s/*` becomes `@cela/*`; the root package is `cela`; the MCP bin `pi-durable-mcp` is `cela-mcp` and
    its server name is `cela`.
  - Go module of `packages/egress-proxy`: `github.com/gscode1/cela/egress-proxy`.
  - Helm chart `charts/pi-durable` becomes `charts/cela` (chart name, release name, template helpers `cela.*`,
    `app.kubernetes.io/part-of: cela`).
  - Label and annotation keys: `pi-durable-k8s/session-id` and `pi-durable-k8s/netprobe` become `cela/session-id` and
    `cela/netprobe`; `pi-durable.dev/*` becomes `cela.dev/*`; `pi-durable/onecli-mode` becomes `cela/onecli-mode`; the e2e
    namespace label `pi-durable-e2e` becomes `cela-e2e`.
  - Namespaces: `pi-durable-poc` becomes `cela-dev`, `pi-durable-e2e` becomes `cela-e2e`, and the generic example namespace
    `pi-durable` becomes `cela`. The kind cluster defaults to `cela`. The per-run namespace `pi-e2e-<id>` is unchanged.
  - GitHub URLs `github.com/gscode1/pi-durable-k8s` become `github.com/gscode1/cela`.
- **Keeps the `pi-` prefix:** component names and images (`pi-env`, `pi-conv-<n>`, `pi-orchestrator`, `pi-ingest`,
  `pi-egress-proxy`, `pi-postgres`, `pi-onecli`, `ghcr.io/gscode1/pi-*`). They name Pi-specific parts, and renaming them
  would change every Service, Secret and image reference for no gain.
- **Not renamed:** the upstream framework (Pi Durable, `@earendil-works/pi-durable`), the Postgres adapter and its fork
  (`@gscode1/pi-durable-postgres`), and the `PI_DURABLE_*` environment variables, whose schema default is the unchanged
  `durable`. Existing ADRs and `docs/research/` keep the old names as written; they are history.

## Consequences

- Existing installs do not upgrade in place. The namespace, the release, the chart name and the label keys change, so the
  operator makes a fresh install. There is no data migration for the proof of concept; sandboxes and claims carrying the old
  `pi-durable-k8s/session-id` label are not recognised by the new orchestrator's sweeper.
- The GitHub repository is renamed to `cela` right after this change merges. GitHub redirects the old URL, so existing links
  and clones keep working; the Go module path matches the new URL.
- Docs and scripts that name `pi-durable-poc` or `pi-durable` now name `cela-dev` or `cela`. Someone with the old name in a
  local `values` file, kube context or shell history has to update it.
