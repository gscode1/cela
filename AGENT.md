# AGENT.md

## Project

pi-durable-k8s: a proof of concept for running Pi Durable agents on our own Kubernetes cluster. Agent state is stored in PostgreSQL (CloudNativePG). Tools run in a per-session gVisor sandbox (kubernetes-sigs/agent-sandbox) with a workspace PVC, through a `pi-env` bridge. Sessions are served by a small session API. Stack: TypeScript (Node). License: MIT.

Read `plan.md` first. It holds the goal, decisions, architecture, phases and repo layout. Then read `README.md` and `docs/` once they exist. Use the terms in `plan.md` (orchestrator, sandbox-env, SandboxClaim, session API) in code. Do not invent synonyms.

## Toolchain

- Pin exact versions of Pi Durable, the Postgres adapter fork and the vendored Agent Sandbox SDK. Upgrade only on purpose.
- Checks (must pass before any PR): `pnpm check` (build, lint, format, typecheck, unit tests)
- Tests must not depend on run order, fixed ports, paths outside a temp dir, or global state that is left unreset. Give every test a timeout so a hang fails the test.

## Git workflow (mandatory)

- Start every change from a GitHub issue. Reuse an existing one if there is one: `gh issue list --state all --search "<words>"`. Otherwise create one: `gh issue create -t "<title>" -b "<problem, expected outcome>"`. Name the branch `<issue-number>-<slug>`.
- Use one worktree per change, cut from a fresh `origin/main`: `git fetch && git worktree add ../worktrees/pi-durable-k8s-<topic> -b <topic> origin/main`. The main checkout stays on `main` and gets no commits.
- Make small commits, one logical change each, with imperative subjects. No WIP or fixup commits in a PR.
- Push explicitly: `git push -u origin <topic>`.
- Open the PR with `gh pr create --fill`. The body has `Closes #<n>.`, what changed, why, and which checks ran.
- Merge only after all checks pass: `gh pr merge --squash --delete-branch <n>`.
- Clean up afterwards: `git -C <main checkout> pull --ff-only`, remove the worktree, delete the local branch, and confirm the issue is closed.
- Never force-push to `main`, rewrite shared history, or bypass checks.

## Coding rules

- Keep modules small, typed and deep. Use strict TypeScript and no `any`.
- Do not add an abstraction with only one implementation. The one exception is the vendored Agent Sandbox SDK, which stays isolated behind a single module.
- Match the existing style. Comments explain why, not what.
- Respect layer boundaries (orchestrator, sandbox-env, session API). A new dependency across layers is a design change.
- Docs are the contract. If code and docs disagree, fix one of them in the same PR. Record new decisions in `docs/decisions/` in the same PR.
- Enforce architectural invariants with tests, for example single owner per schema or no sandbox access to Postgres.
- Never delete or skip a failing test to get green.

## Secrets and data

- Never commit `.env` files, keys, tokens or credentials. Never print or log secret values.
- Secrets come from the environment only.
- Model credentials stay in the orchestrator and are never mounted into sandboxes.
- Tests use temp data dirs or throwaway namespaces and databases. Never touch production systems; use the lab cluster.

## Working as an AI agent

- Plan, implement, then verify. Run the checks and read the diff before you report done.
- A subagent's report is not proof. Verify it yourself.
- Give each worker a self-contained brief: the goal, the docs and files involved, the acceptance checks, and what not to touch.
- Stop and ask before any irreversible action, or when a request contradicts `plan.md` or the docs.
