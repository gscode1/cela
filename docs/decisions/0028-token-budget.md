# 0028: Per-session token budget

Status: accepted, 2026-11-18 (issue #178). Amends [0008](0008-settings-in-postgres.md).

## Context

The security baseline in `plan.md` asks for "a per-session turn and token budget". Only the turn budget existed. A
session within its turn budget could still spend without bound: long contexts, large tool output and compaction all
cost tokens without adding turns.

Pi Durable already keeps the ledger: each conversation's `pi.usage` document holds token and cost totals per
`provider/model` (failed and aborted attempts and compaction included) and per tool that reports usage. Nothing read it.

## Decision

- **A `tokenBudget` setting** (`inbox.settings.token_budget`, `bigint`, nullable): the tokens one session may use in
  total, the sum of `totalTokens` over every bucket of its conversation's `pi.usage`. `null` is no limit and the
  default, so existing deployments keep their behaviour. It is seeded from `PI_SESSION_TOKEN_BUDGET` (chart value
  `models.tokenBudget`) and changed with `PUT /admin/settings` or the console's settings page, like `turnBudget`.
- **Checked at admission**, next to the turn budget, before every message and steer: a session whose conversation used
  `tokenBudget` tokens or more becomes `failed` with "token budget exhausted" and the input is refused. A change of the
  setting applies to every session from its next input.
- **One run may overshoot.** The check runs between inputs, not inside a run, so a single run can spend past the budget
  by what that run costs. The turn budget (`maxTurns`) still bounds how long one run goes. In-run enforcement would
  need a generation hook that ends the run, which Pi Durable 1.5.2 offers no clean way to do (`beforeRequest` can only
  replace the messages). We revisit it if the overshoot matters in practice.
- **Not in this decision:**
  - showing usage on the session API (#185). Ingest has no Harness, so the orchestrator would have to publish usage.
  - a cost budget in money. Costs come from pi-ai's catalog and are not known for every provider; tokens are.

## Addendum: per-profile budget (#184)

A profile may set `tokenBudget` (1 to 1000000000000). It replaces the setting for that profile's sessions, also when the
setting is `null` (no limit): `definition.tokenBudget ?? settings.tokenBudget`, from the session's profile snapshot like
`turnBudget`. A profile cannot say "no limit" under a global budget; leaving the field out inherits the setting. The
console's editor, diff, preview and admission check carry the field, so a save from the console keeps a value set
through the API.

## Consequences

- Sessions over the budget fail like those over the turn budget, with a fixed message and `409` for further events.
- The budget counts a conversation's own `pi.usage`. A subagent conversation would count separately; the orchestrator
  creates none today.
