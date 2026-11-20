# 0049: The sandbox's facts in every session's instructions

Status: accepted, 2026-11-20 (issue #320). Builds on [0015](0015-repo-context.md) (instruction order),
[0038](0038-network-modes.md) (network modes), [0041](0041-browser-sandbox.md) (flavours) and
[0048](0048-sandbox-image-tools.md) (the default image's tools).

## Context

A session's instructions held only the profile's text, the skill catalog and, for a repo session, the repo's context
file. Nothing told the agent where it runs. A `renovate` session asked to check a PR found an empty `/workspace` (it had
no `repo`) and spent its turns trying `git`, `curl`, `apt-get` and writes to `HOME` before it gave up. A skill does not
help: the agent reads a skill only when it already knows it needs it, and these facts are needed before the first command.

## Decision

The orchestrator appends a `<sandbox_environment>` block to every new conversation's instructions
(`packages/orchestrator/src/sandbox-environment.ts`). It is built from the session row and the deployment, never from the
sandbox:

- user `pi` (uid 1000) without root, `/workspace` persistent and the rest not, what is writable (`/workspace`, `/tmp`, `HOME`),
  no apt;
- the flavour's tools (`FLAVOUR_FACTS`, pinned against each Dockerfile by `test/sandbox-environment.test.ts`);
- the repository and the branch it was **cloned from** (the agent may switch), or that none is checked out;
- the network: the session's mode, or `direct` when the deployment runs without the egress proxy (ADR 0038 "Proxy
  disabled").

**Facts only.** What to do about them (stop, ask, comment) is the profile's business, in its instructions.

**Deterministic per session.** No tokens, addresses or timestamps, and every input is fixed at creation (flavour, mode and
repo are, ADR 0038 and 0041), so the text never changes under a running conversation and does not churn the prompt cache.

**Order.** Profile instructions, sandbox facts, project instructions, skill catalog. One builder (`composeInstructions`)
serves both the creation (`Host.createConversation`) and the repo rescan at each message (`SessionService.#refreshRepoContext`),
so a rescan cannot drop the block. It comes before the repo's context file, so a repository's text cannot precede it. The
only session inputs in it are the repo and branch names, validated at creation (docs/repo-workspace.md).

## Consequences

- About 150 tokens per conversation.
- Conversations created before this change do not get the block; a repo session with `repoSkills` or `repoContext` gets it at
  its next rescan.
- A change to an image's tools must update `FLAVOUR_FACTS`; the test fails until it does.
