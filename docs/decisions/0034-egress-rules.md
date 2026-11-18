# 0034: Egress rules in Postgres: rule sets, admin API and explain

Status: accepted, 2026-11-18 (issue #244, slice 2 of epic #50). Builds on [0012](0012-egress-proxy-spike.md) (the proxy
spike), [0008](0008-settings-in-postgres.md), [0010](0010-session-profiles.md), [0023](0023-admin-revisions.md),
[0027](0027-admin-delete.md) and [0032](0032-repo-allowlist.md).

## Context

Epic #50 puts all sandbox egress behind our own proxy and manages what it allows as data: adding a host is one admin API
call, not a GitOps change. This slice is the data and the admin API only. The proxy (slice 3) will read the same rows
and call the same evaluator, so the rules cannot mean one thing in the API and another in the proxy. The admin console
page for rule sets (slice 2b, issue #246) follows in the admin UI ([plan](../admin-ui-plan.md)); nothing enforces rules until
slice 3.

## Decision

### Rule sets, and what applies to a session

- **Rules live in named rule sets** (`packages`, `github-public`, `open-web`, ...). A profile names the sets it uses in its
  definition (`egressRuleSets`, [0010](0010-session-profiles.md)); a set with `applies_to_all` applies to every
  session. This replaces a per-rule scope: "global" is a set that applies to all, "profile" is a set only that profile
  names.
- **A rule belongs to exactly one rule set, or to one session.** A session's own rules are temporary and per session:
  the orchestrator will write them later (for example `github.com` with `route: onecli` for a repo session).
- **The effective rules of a session** are the rules of the sets that apply to all, of the sets its profile names, and
  its own.
- **Profiles.** `egressRuleSets` is a list of set names, validated like the other name lists. Each must exist when the
  profile is written (checked inside the write, under the catalog lock a set delete also takes). A rule set that a
  profile's current version names cannot be deleted: `409` with `blockedBy.profiles`, as the other deletes
  ([0027](0027-admin-delete.md)). A set that a profile *snapshot* of a running session names can still be deleted;
  that session then has fewer rules, which is the safe direction. Rule set names are free to reuse after a delete.

### Schema `egress` (migration `024_egress.sql`)

- **`egress.rule_sets`**: `name` (the profile name syntax), `description`, `applies_to_all`, `revision`, created and
  updated time and actor.
- **`egress.rules`**: `id`, `rule_set` (a foreign key, on delete cascade) or `session_id` (exactly one of the two),
  `effect`, `host`, `ports` (`integer[]`, default `{443}`), `route`, `allows_private`, `expires_at`, `note`,
  `revision`, created and updated time and actor.
- **`egress.revisions`**: a log with one row per write request; the highest `revision` is the revision of everything
  in the schema (0 on an empty one). One number for all of it, because the proxy needs a single value to say which
  snapshot it holds, and a console edits a list.
- **`egress.rules_history`**: one row per change of a rule set or rule: `revision`, actor, time, `kind`
  (`rule-set`, `rule`), `ref` (the set's name or the rule's id), action and the old and new value as JSON. A set's
  delete keeps the rules it took with it in `old`. Append-only.
- **Every write** takes the advisory lock `egress:rules`, checks `expectedRevision`, adds a `revisions` row, writes its
  rows and history and runs `select pg_notify('egress_rules', '<revision>')`, in one transaction. The notification is
  delivered at commit. A change that alters nothing writes nothing.
- **Seed.** (Replaced in part, see the addendum "One packages set".) The migration creates these rule sets once, when no revision exists, all with `applies_to_all = false` and
  all rules `allow`, `direct`, port 443 unless noted: `npm` (`registry.npmjs.org`), `pypi` (`pypi.org`,
  `files.pythonhosted.org`), `debian` (`deb.debian.org`, `security.debian.org`; ports 80 and 443), `github-public`
  (`github.com`, `codeload.github.com`, `.githubusercontent.com`), `go` (`proxy.golang.org`, `sum.golang.org`), `rust`
  (`crates.io`, `index.crates.io`, `static.crates.io`) and `open-web` (`*`). They are ordinary rows, editable and
  deletable, with no history entry. Which sets apply to all sessions is not decided: none does.
- **Not in this slice**: `egress.principals` (session, token hash, profile, pod IP, revoked) comes with slice 4 and
  `egress.bindings` (session to OneCLI token) with slice 5. A migration test checks that neither exists yet.
- **Owner of the schema.** session-core's migrations create it and ingest's admin API is the only writer; the orchestrator
  will write session rules through the same functions. Nothing in `inbox` refers to it, and the sandbox has no database
  access (unchanged). The read-only Postgres role for the proxy does not exist: the repository has no role or grant
  pattern for other readers, so it arrives with the proxy in slice 3 (select on the four tables).

### Rule shape

- **Host.** Lowercase, no trailing dot, a DNS name of letters, digits and hyphens (punycode for non-ASCII), at most 253
  characters. Forms:
  - `registry.npmjs.org`: exact.
  - `.githubusercontent.com` (leading dot): every subdomain at any depth, **not** the bare domain (add an exact rule
    for it). An allow suffix needs two labels, so no allow covers a whole top-level domain; a deny may (`.ru`).
  - `*`: any host (see below).
  - a CIDR such as `10.20.0.0/16`: a **cidr** match, valid only on a private rule (see below).
  Any other wildcard, a path, a port, a scheme and an IP literal in any spelling (dotted, integer, hex, IPv6) are
  refused as a host. A public rule never names an address; the proxy decides on the resolved one.
- **Ports.** 1 to 32 distinct integers from 1 to 65535, sorted. A rule applies to the listed ports only.
- **Route.** `direct` or `onecli`. `onecli` only on an allow of a named public host: a deny is always `direct`, `*` is
  always `direct` and so is a private rule, so OneCLI, which decrypts what it carries, sees only hosts an admin named.
- **`expiresAt`.** An ISO 8601 timestamp with a zone, in the future when set. From that instant on the rule is ignored
  by evaluation; it is not removed, so the console can show it and an admin can extend it.
- **Limits.** At most 2000 rules and 200 rule sets (a write past it is `409`), a note or description of at most 500
  characters.

### Evaluation (`evaluateEgress`, session-core, pure)

`evaluateEgress(ruleSets, rules, { host, port, sessionId?, profileRuleSets?, addresses?, now })`. Precedence:

0. **Always-blocked addresses** (below) deny whatever the rules say. Only when `addresses`, the addresses the host
   resolved to, are given; the proxy always has them, `explain` takes them as an optional input.
1. **Any matching deny wins**, whatever its host specificity or whether it comes from a set or from the session.
2. **Else the most specific matching allow.** Host specificity: an exact host, then a cidr, then a longer suffix, then
   a shorter suffix, then `*`. On equal host specificity a **session rule beats a rule set's rule**. If the best allows
   that remain disagree on the route (two rule sets: `direct` and `onecli`), the answer is a deny with the reason
   "conflicting routes" and `conflictingRuleIds`, and `explain` shows both rules: fail closed, and the admin fixes it.
   Equal routes are no conflict; the older rule (lower id) is reported.
3. **Else deny** (default deny).

A rule *matches* when it has not expired and lists the port. The request host is compared case-insensitively with one
trailing dot ignored. A request host that is not a DNS name, an IP literal or a port outside 1 to 65535 is denied
without consulting the rules. The result is `{ decision, route, matchedRuleId, ruleSet, reason }` (`route` is null for a
deny; `ruleSet` is the set of the matching rule, null for a session rule), plus `conflictingRuleIds` and `needsPrivate`
where they apply.

Host specificity ranks before who owns the rule on purpose: a rule set's exact rule with `route: onecli` for
`api.github.com` must not be overridden by a session's broader suffix that says `direct`, or the credential would
silently stop being injected. On the *same* host a session rule wins, which is how the orchestrator gives one session a
different route.

### Open web: the `*` host

A profile that needs the open web (a scraping agent) names the `open-web` set (one rule, host `*`, port 443; add 80 if
wanted). `*` is allowed with either effect, in any rule set or as a session rule, always `direct`, and is the least
specific allow: any named allow beats it (so `api.github.com` with `route: onecli` still goes through OneCLI) and any
matching deny beats it (a deny for a host in a set that applies holds for the scraper too). **`*` never reaches private
addresses**: see the next section.

### Address safety: two tiers, and the private flag

Hosts resolve to addresses, and the destination address is what decides how dangerous a connection is. Two tiers
(the proxy enforces them on the resolved IP, slice 3; this module is the reference and `explain` uses it):

1. **Always blocked: no rule can open them.** Loopback (`127.0.0.0/8`, `::1`), link-local including cloud metadata
   (`169.254.0.0/16`, `fe80::/10`, `fd00:ec2::254`), "this network" (`0.0.0.0/8`, `::`), multicast and reserved space
   (`224.0.0.0/4`, `240.0.0.0/4`, `ff00::/8`) and IPv4-mapped IPv6 as such (`::ffff:a.b.c.d` is judged as the IPv4
   address). On top of these, **the platform itself**: the namespace's own services (Postgres, the orchestrator,
   ingest, the OneCLI API) and the Kubernetes API. Why: through them a sandbox can take over the platform or read
   other sessions' data (credentials, conversations, the model keys). Validation rejects a private rule whose cidr
   overlaps the static ranges. **Which cluster addresses are "the platform" is deployment knowledge**: slice 2 cannot
   check it, so the namespace and kube-API check is the proxy's (slice 3), from its own configuration.
2. **Denied by default, but enable-able: private and cluster addresses.** RFC 1918 (`10/8`, `172.16/12`, `192.168/16`),
   CGNAT `100.64/10`, ULA `fc00::/7`, documentation and benchmarking ranges, and the cluster's Service and Pod ranges
   (added by the proxy's configuration). A host that resolves to one is denied **even when the host is allowed**, unless
   an allow rule with `private: true` covers it. Use case: an agent that calls the user's own services in the cluster.

A **private rule** (`private: true`) is narrow by construction:
- an **allow** only, route `direct`, with **explicit ports** (no default);
- its host is an **exact name** (`billing.payments.svc.cluster.local`, not `localhost`) or a **cidr** (`10.20.0.0/16`,
  IPv4 or IPv6), at least /8 for IPv4 and /32 for IPv6 (so `0.0.0.0/0` is impossible), a network address, not
  overlapping the always-blocked ranges;
- never `*` or a suffix, and never `onecli`;
- a cidr on a rule that is not private is refused (public destinations are matched by name). A cidr outside the private
  ranges is accepted, since cluster ranges can be anything, and only matters for addresses the proxy classes as private.

How evaluation uses it: a **public** address is judged by the rules that are not private; a **private** address only by
private rules (an exact host, or a cidr that contains the address); an always-blocked address by none. Every address of
a host must be allowed, so a host with one public and one private record needs both. `explain` takes optional
`addresses` and sets `needsPrivate` when the decision depended on the flag; its reason says "resolves to a private
address; it needs an allow rule with `private: true`".

**Two layers must agree.** After the network cutover (slice 6) a sandbox can reach only the proxy, and the proxy's own
NetworkPolicy must allow the private destinations it may connect to. That will be a chart value listing
operator-approved CIDRs and namespaces (designed in slices 3 and 6). Enabling an internal service therefore takes a
chart value (network layer) **and** a private rule (proxy layer); a rule alone cannot punch through the network
policy, and a network policy alone does not make the proxy connect.

### Admin API (ingest, admin only)

| Route | |
|---|---|
| `GET /admin/egress/rule-sets` | `{ revision, ruleSets: [{ name, description, appliesToAll, ruleCount, ... }], invalid }` in one snapshot |
| `POST /admin/egress/rule-sets` | create (`name` in the body), `201` |
| `GET /admin/egress/rule-sets/{name}` | the set with its rules |
| `PUT /admin/egress/rule-sets/{name}` | partial update of `description` and `appliesToAll` |
| `DELETE /admin/egress/rule-sets/{name}?expectedRevision=N` | with its rules; `409` while a profile names it |
| `POST /admin/egress/rule-sets/{name}/rules` | add a rule, `201`; `404` if the set is missing |
| `PUT /admin/egress/rules/{id}`, `DELETE /admin/egress/rules/{id}?expectedRevision=N` | change or remove a rule of a set or a session |
| `GET /admin/egress/sessions/{id}/rules`, `POST /admin/egress/sessions/{id}/rules` | a session's own rules |
| `POST /admin/egress/explain` | `{ host, port?, sessionId?, profile?, addresses? }` to the evaluation result, plus the normalised `host`, `port`, `revision`, `profileRuleSets`, the full `matchedRule`, `conflictingRules` and `addressesChecked` |
| `GET /admin/egress/status` | `{ revision, ruleSets, rules, invalid, proxy }` |
| `GET /admin/egress/history` | newest first; `?kind=`, `?ref=`, `?limit=` |

- **Revisions** work as in [0023](0023-admin-revisions.md): `expectedRevision` is the revision of the whole schema, `0`
  for an empty one; a mismatch is `409` and changes nothing. Omitted on a `POST` or `PUT`, the last writer wins.
  Required on a `DELETE`. Every write, of a set or a rule, bumps it.
- **`explain`** reads the stored rules and calls the same evaluator. `port` defaults to 443. With `profile` it resolves
  the profile's current `egressRuleSets` (`400` for an unknown profile); with `sessionId` it adds that session's own
  rules. It does not look up a session's profile, so give both to see what the session would get, and it does not
  resolve DNS: pass `addresses` to ask "if it resolves to ...".
- **`status`**: `proxy.replicas` is an empty placeholder; from slice 3 each proxy replica reports the revision it last
  read, so an admin can see whether a change has arrived (the epic's "effective in under 10 s").
- **Session rules** are written by an admin here; the session need not exist, and a rule for a deleted session is inert.

## Consequences

- Rules take effect nowhere until the proxy exists (slice 3); the NOTIFY has no listener yet.
- A profile's `egressRuleSets` is part of its definition, so a change is a new profile version, like any other field.
  The admin console edits it in the profile editor (slice 2b), next to the Egress page for rule sets and their rules.
- One global revision means two admins editing unrelated rules can see a `409`. A reload resolves it.
- The evaluator is O(rules) per request. At 2000 rules the proxy can run it per connection; slice 3 may index it.
- Sessions pin a profile snapshot, so the proxy needs the profile's rule set names per session (slice 4 principals).

## Addendum: one `packages` set (migration `030_egress_packages.sql`)

The seeded `npm`, `pypi`, `debian`, `go` and `rust` sets were too granular for the admins of this proof of concept. They
are replaced by one set, `packages` ("Package registries and mirrors"): `allow`, `direct`, `applies_to_all = false`,
with `registry.npmjs.org`, `registry.yarnpkg.com`, `pypi.org`, `files.pythonhosted.org`, `deb.debian.org` and
`security.debian.org` (ports 80 and 443 for the two Debian hosts, 443 for the rest), `proxy.golang.org`,
`sum.golang.org`, `crates.io`, `index.crates.io` and `static.crates.io`. `github-public` and `open-web` stay as they
were. A fresh database therefore has `packages`, `github-public`, `open-web` and the system set `mcp-catalog`.

- Migration 024 is unchanged (an applied migration never is), so a fresh database seeds the old sets and 030 converts
  them in the same run, as it does on an existing one.
- 030 creates `packages` unless a set of that name exists, and deletes each old set only when it is **untouched**: the
  set row and its rules are as 024 wrote them (same description, revision, `created_by` and `updated_by` `migration
  024`, exactly the seeded rules), `egress.rules_history` has no entry for it, and no profile version of any age names
  it. Any other old set stays, unedited. A database where 024 found a revision and seeded nothing loses nothing.
- It writes like the admin API: one revision, history rows (actor `migration 030`; the deleted sets keep their rules in
  `old`), and a NOTIFY. It runs once, guarded by its own revision row.
- Hosts a deleted set allowed to a session through a profile cannot be lost by this: a profile that names a set keeps it.
