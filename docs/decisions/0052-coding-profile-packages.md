# 0052: Coding sessions can install packages, and know what they may reach

Status: accepted, 2026-11-21 (issue #332). Builds on [0034](0034-egress-rules.md) (egress rules, "one `packages` set"),
[0048](0048-sandbox-image-tools.md) (the default image's tools) and [0049](0049-sandbox-environment-instructions.md)
(the sandbox facts in the instructions).

## Context

In a live test the seeded `coding` profile named no egress rule set, so every package host was default-denied. The first
`pnpm install`, corepack download or Go toolchain download of each repo session failed with `407 Request rejected by
proxy`, which says nothing about hosts or rules. The agents were told only that "the session's egress rules decide which
hosts answer". One pushed four commits it had never built; two others reported partial results or opened a PR with Go
code it never compiled. ADR 0034 and 0048 make egress the profile's choice, which stays true: the defect is the default.

## Decision

- **`coding` version 4** (migration `034_coding_packages.sql`) adds `egressRuleSets: ["packages"]` and an instruction: a
  change that could not be built or tested must be reported as such, in the final message and in any pull request, and
  must not be presented as verified or pushed as done. Written only while `coding` is still exactly the version 3 that
  migration 013 seeded (`created_by = 'seed'`), and only while the `packages` rule set exists; a profile an operator has
  edited is theirs. Sessions already created keep their snapshot. `packages` stays an ordinary set: an operator removes
  it from `coding` by writing the next version, and a profile other than `coding` still opts in by naming it.
- **The sandbox facts name the rule sets** of the profile snapshot (`egressRuleSets`), and say what a refusal looks like
  and that it is a rule, not a broken network. The sets are named, their hosts are not: an operator edits the rules while
  the session runs, and the text must not change under a running conversation (ADR 0049, "Deterministic per session").
  `POST /admin/egress/explain` answers "may this host be reached" for an operator.
- **The proxy says why it refused.** A 407 that an ACL decision caused now has the reason phrase `Request rejected by
  proxy: <host:port> is not allowed by the session's egress rules` (Smokescreen's `RejectResponseHandlerWithCtx`, no fork).
  The reason phrase is what npm, curl and git print next to the code. A 407 for a bad or revoked egress token keeps the
  old phrase, so a credential problem is not blamed on the rules. The host is client input: control characters are dropped
  and its length capped, so it cannot split the status line. The body and `X-Smokescreen-Error` header already carried the
  rule's reason.

## Consequences

- A fresh install's coding sessions reach npm, PyPI, Debian, Go and crates.io hosts, and nothing else new. Operators who
  want sessions with no package access write a `coding` version without the set.
- The `packages` hosts are a supply-chain surface: a session can now fetch and run any package from them. That is the
  point of the default, and the set remains editable.
- Existing deployments get version 4 at the next start only if `coding` was never edited.
