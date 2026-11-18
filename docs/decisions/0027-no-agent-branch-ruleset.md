# 0027: No enforced agent branch ruleset; branch protection is the repository owner's job

Status: accepted, 2026-11-17 (issue #160). Supersedes the `agent/**` ruleset of issue #64. The number skips 0026, which
another change reserved.

## Context

A repository session gets a GitHub App token with `contents: write` and `pull_requests: write` on that repository
(`docs/repo-workspace.md`), and GitHub cannot scope a token by ref. Issue #64 answered this with `hack/agent-ruleset.json`, a
repository ruleset applied by `hack/agent-ruleset.sh`. It covered every branch except `agent/**` against creation, update,
deletion and force-push, with only the Admin role allowed to bypass.

In practice it was the wrong layer and too broad:

- It froze every non-`agent/**` branch for everyone without bypass, people and other bots included. It was a policy on the
  whole repository, imposed because of one App.
- Agents could not work on an existing feature branch or one a person started.
- It was an operator step per repository, needed a public repository or a paid plan, and nothing checked it at runtime.
- GitHub's own branch protection on `main` and release branches already gives the safety that matters.

## Decision

- **pi-durable does not impose a branch policy.** The ruleset files are removed. Which branches are protected, and how, is the
  repository owner's choice, made with GitHub's branch protection or rulesets.
- **The docs say plainly what is at stake.** Whatever the repository does not protect, a session can push to, force-push,
  delete or merge into. They recommend at least a required pull request with review, no force-push and no deletion on `main`
  and release branches, and never the App as a bypass actor.
- **Any branch name.** `branch` in `POST /sessions` no longer needs an `agent/` prefix.

## Consequences

- A repository with no protection is fully writable by its sessions. This is the same exposure as giving any automation a
  write token, and the owner decides on it.
- Repositories that already carry the `pi-agent-branches` ruleset keep it until their owner deletes it (repository settings,
  Rules). pi-durable neither needs it nor checks it. The phase-4c e2e still pushes `agent/pi-e2e-*` so test repositories with
  the old ruleset keep passing.
- If a stronger, repository-independent control is wanted later, it belongs in our own egress path (issue #50), for example
  allowing a session to push only to the branch it was created with.
