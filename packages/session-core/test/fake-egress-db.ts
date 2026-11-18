import type pg from "pg";

export interface SetRow {
  name: string;
  description: string;
  applies_to_all: boolean;
  revision: number;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

export interface RuleRow {
  id: number;
  rule_set: string | null;
  session_id: string | null;
  effect: string;
  host: string;
  ports: number[];
  route: string;
  allows_private: boolean;
  expires_at: string | null;
  note: string;
  revision: number;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

interface HistoryRow {
  id: string;
  revision: string;
  changed_at: Date;
  changed_by: string;
  kind: string;
  ref: string;
  action: string;
  old: unknown;
  new: unknown;
}

type Result = Promise<{ rows: unknown[]; rowCount: number }>;

/**
 * An in-memory stand-in for the `egress` schema, answering only the statements egress-store.ts issues (the approach of
 * FakeSettingsDb), plus the two profile reads the admin API makes. `begin` snapshots and `rollback` restores;
 * notifications are collected at `commit`, like Postgres delivers them. Advisory locks are not modelled: the tests that
 * use it write one request at a time. No seed: a fresh instance is revision 0 with nothing in it.
 */
export class FakeEgressDb {
  ruleSets: SetRow[] = [];
  rules: RuleRow[] = [];
  /** The `revision` of each row of egress.revisions, with who wrote it. */
  revisions: { revision: number; changed_by: string }[] = [];
  history: HistoryRow[] = [];
  /** Payloads of the notifications on `egress_rules` that committed. */
  readonly notifications: string[] = [];
  /** Profiles by name: the `egressRuleSets` of their current version. */
  profiles = new Map<string, string[]>();
  /** What the proxy replicas wrote to egress.proxy_status; `silent_seconds` is what the database clock would say. */
  proxyStatus: {
    replica: string;
    revision: number | null;
    state: string;
    last_read_at: Date | null;
    started_at: Date;
    version: string;
    updated_at: Date;
    silent_seconds: number;
  }[] = [];
  /** egress.principals (ADR 0036); the table's trigger notifies `principals` on every write that changes a row. */
  principals: {
    session_id: string;
    token_hash: string;
    token_salt: string;
    profile_name: string | null;
    profile_version: number | null;
    rule_sets: string[];
    pod_ip: string | null;
    revoked_at: Date | null;
  }[] = [];
  #nextRule = 1;
  #pending: string[] = [];
  #snapshot:
    | {
        ruleSets: SetRow[];
        rules: RuleRow[];
        revisions: FakeEgressDb["revisions"];
        history: HistoryRow[];
      }
    | undefined;

  asPool(): pg.Pool {
    return this as unknown as pg.Pool;
  }

  connect(): Promise<{ query: FakeEgressDb["query"]; release: () => void }> {
    return Promise.resolve({ query: (sql, params) => this.query(sql, params), release: () => {} });
  }

  get revision(): number {
    return this.revisions.at(-1)?.revision ?? 0;
  }

  /** Puts a rule set in as a hand edit would: no revision, no history. */
  insertRawSet(name: string, extra: Partial<SetRow> = {}): void {
    this.ruleSets.push({
      name,
      description: "",
      applies_to_all: false,
      revision: 0,
      created_at: new Date(0).toISOString(),
      created_by: "hand",
      updated_at: new Date(0).toISOString(),
      updated_by: "hand",
      ...extra,
    });
  }

  /** Puts a rule in as a hand edit would: no revision, no history. */
  insertRaw(row: Partial<RuleRow> & { host: string }): void {
    this.rules.push({
      id: this.#nextRule++,
      rule_set: null,
      session_id: "11111111-2222-4333-8444-555555555555",
      effect: "allow",
      ports: [443],
      route: "direct",
      allows_private: false,
      expires_at: null,
      note: "",
      revision: 0,
      created_at: new Date(0).toISOString(),
      created_by: "hand",
      updated_at: new Date(0).toISOString(),
      updated_by: "hand",
      ...row,
    });
  }

  #principalQuery(text: string, params: unknown[]): Result {
    const done = (rows: unknown[] = []): Result => Promise.resolve({ rows, rowCount: rows.length });
    const row = this.principals.find((p) => p.session_id === params[0]);
    if (text.startsWith("select token_salt, revoked_at from egress.principals")) {
      return done(row === undefined ? [] : [row]);
    }
    if (text.startsWith("insert into egress.principals")) {
      if (row !== undefined) return done();
      const [id, hash, salt, name, version, sets] = params as [
        string,
        string,
        string,
        string | null,
        number | null,
        string[],
      ];
      if (this.principals.some((p) => p.token_hash === hash))
        throw new Error("duplicate token_hash");
      this.principals.push({
        session_id: id,
        token_hash: hash,
        token_salt: salt,
        profile_name: name,
        profile_version: version,
        rule_sets: sets,
        pod_ip: null,
        revoked_at: null,
      });
      this.notifications.push("principals");
      return Promise.resolve({ rows: [], rowCount: 1 });
    }
    if (text.startsWith("update egress.principals set pod_ip")) {
      if (row === undefined || row.revoked_at !== null || row.pod_ip === params[1]) return done();
      row.pod_ip = params[1] as string | null;
      this.notifications.push("principals");
      return Promise.resolve({ rows: [], rowCount: 1 });
    }
    if (text.startsWith("update egress.principals set revoked_at")) {
      if (row === undefined || row.revoked_at !== null) return done();
      row.revoked_at = new Date();
      row.pod_ip = null;
      this.notifications.push("principals");
      return Promise.resolve({ rows: [], rowCount: 1 });
    }
    if (text.startsWith("select session_id from egress.principals where revoked_at is null")) {
      return done(
        this.principals
          .filter((p) => p.revoked_at === null)
          .map((p) => ({ session_id: p.session_id })),
      );
    }
    if (text.startsWith("select count(*) filter")) {
      const live = this.principals.filter((p) => p.revoked_at === null);
      return done([
        {
          active: String(live.length),
          with_pod_ip: String(live.filter((p) => p.pod_ip !== null).length),
          revoked: String(this.principals.length - live.length),
        },
      ]);
    }
    if (text.startsWith("select profile_name, rule_sets, revoked_at from egress.principals")) {
      return done(row === undefined ? [] : [row]);
    }
    throw new Error(`FakeEgressDb: unhandled principals statement: ${text.slice(0, 80)}`);
  }

  query(sql: string, params: unknown[] = []): Result {
    const done = (rows: unknown[] = []): Result => Promise.resolve({ rows, rowCount: rows.length });
    const text = sql.replace(/\s+/g, " ").trim();
    const now = new Date().toISOString();
    if (text === "begin") {
      this.#snapshot = {
        ruleSets: this.ruleSets.map((row) => ({ ...row })),
        rules: this.rules.map((row) => ({ ...row })),
        revisions: [...this.revisions],
        history: [...this.history],
      };
      return done();
    }
    if (text === "commit") {
      this.#snapshot = undefined;
      this.notifications.push(...this.#pending);
      this.#pending = [];
      return done();
    }
    if (text === "rollback") {
      if (this.#snapshot !== undefined) {
        this.ruleSets = this.#snapshot.ruleSets;
        this.rules = this.#snapshot.rules;
        this.revisions = this.#snapshot.revisions;
        this.history = this.#snapshot.history;
      }
      this.#snapshot = undefined;
      this.#pending = [];
      return done();
    }
    if (text.includes("from egress.proxy_status")) {
      return done([...this.proxyStatus].sort((a, b) => a.replica.localeCompare(b.replica)));
    }
    if (text.includes("egress.principals")) return this.#principalQuery(text, params);
    if (text.startsWith("select pg_advisory_xact_lock")) return done();
    if (text.startsWith("select pg_notify")) {
      if (params[0] === "egress_rules") this.#pending.push(String(params[1]));
      return done();
    }
    if (text.startsWith("select coalesce(max(revision), 0) as revision from egress.revisions")) {
      return done([{ revision: String(this.revision) }]);
    }
    if (text.includes("jsonb_agg(to_jsonb(s)")) {
      return done([
        {
          revision: String(this.revision),
          rule_sets: [...this.ruleSets].sort((a, b) => a.name.localeCompare(b.name)),
          rules: [...this.rules].sort((a, b) => a.id - b.id),
        },
      ]);
    }
    if (text.startsWith("select count(*) as count from egress.rule_sets")) {
      return done([{ count: String(this.ruleSets.length) }]);
    }
    if (text.startsWith("select count(*) as count from egress.rules")) {
      return done([{ count: String(this.rules.length) }]);
    }
    if (text.startsWith("insert into egress.revisions")) {
      const revision = this.revision + 1;
      this.revisions.push({ revision, changed_by: String(params[0]) });
      return done([{ revision: String(revision) }]);
    }
    if (text.startsWith("insert into egress.rules_history")) {
      const [revision, by, kind, ref, action, old, next] = params as [
        number,
        string,
        string,
        string,
        string,
        string | null,
        string | null,
      ];
      this.history.push({
        id: String(this.history.length + 1),
        revision: String(revision),
        changed_at: new Date(),
        changed_by: by,
        kind,
        ref,
        action,
        old: old === null ? null : (JSON.parse(old) as unknown),
        new: next === null ? null : (JSON.parse(next) as unknown),
      });
      return done();
    }
    if (text.startsWith("update egress.rules_history set ref")) {
      const [ref, revision] = params as [string, number];
      for (const row of this.history) {
        if (row.kind === "rule" && row.ref === "" && row.revision === String(revision))
          row.ref = ref;
      }
      return done();
    }
    if (text.startsWith("select name, description") && text.includes("where name = $1")) {
      const row = this.ruleSets.find((r) => r.name === params[0]);
      return done(row === undefined ? [] : [{ ...row }]);
    }
    if (text.startsWith("insert into egress.rule_sets")) {
      const [name, description, appliesToAll, revision, by] = params as [
        string,
        string,
        boolean,
        number,
        string,
      ];
      const row: SetRow = {
        name,
        description,
        applies_to_all: appliesToAll,
        revision,
        created_at: now,
        created_by: by,
        updated_at: now,
        updated_by: by,
      };
      this.ruleSets.push(row);
      return done([{ ...row }]);
    }
    if (text.startsWith("update egress.rule_sets set")) {
      const [name, description, appliesToAll, revision, by] = params as [
        string,
        string,
        boolean,
        number,
        string,
      ];
      const row = this.ruleSets.find((r) => r.name === name);
      if (row === undefined) return done();
      Object.assign(row, {
        description,
        applies_to_all: appliesToAll,
        revision,
        updated_at: now,
        updated_by: by,
      });
      return done([{ ...row }]);
    }
    if (text.startsWith("delete from egress.rule_sets where name = $1")) {
      this.ruleSets = this.ruleSets.filter((r) => r.name !== params[0]);
      return done();
    }
    if (text.startsWith("delete from egress.rules where rule_set = $1")) {
      const taken = this.rules.filter((r) => r.rule_set === params[0]);
      this.rules = this.rules.filter((r) => r.rule_set !== params[0]);
      return done(taken.map((row) => ({ ...row })));
    }
    if (text.startsWith("insert into egress.rules (")) {
      const [
        ruleSet,
        sessionId,
        effect,
        host,
        ports,
        route,
        allowsPrivate,
        expires,
        note,
        revision,
        by,
      ] = params as [
        string | null,
        string | null,
        string,
        string,
        number[],
        string,
        boolean,
        Date | null,
        string,
        number,
        string,
      ];
      const row: RuleRow = {
        id: this.#nextRule++,
        rule_set: ruleSet,
        session_id: sessionId,
        effect,
        host,
        ports,
        route,
        allows_private: allowsPrivate,
        expires_at: expires?.toISOString() ?? null,
        note,
        revision,
        created_at: now,
        created_by: by,
        updated_at: now,
        updated_by: by,
      };
      this.rules.push(row);
      return done([{ ...row }]);
    }
    if (
      text.startsWith("select id, rule_set") &&
      text.includes("from egress.rules where id = $1")
    ) {
      const row = this.rules.find((r) => String(r.id) === params[0]);
      return done(row === undefined ? [] : [{ ...row }]);
    }
    if (text.startsWith("update egress.rules set")) {
      const [id, effect, host, ports, route, allowsPrivate, expires, note, revision, by] =
        params as [
          string,
          string,
          string,
          number[],
          string,
          boolean,
          Date | null,
          string,
          number,
          string,
        ];
      const row = this.rules.find((r) => String(r.id) === id);
      if (row === undefined) return done();
      Object.assign(row, {
        effect,
        host,
        ports,
        route,
        allows_private: allowsPrivate,
        expires_at: expires?.toISOString() ?? null,
        note,
        revision,
        updated_at: now,
        updated_by: by,
      });
      return done([{ ...row }]);
    }
    if (text.startsWith("delete from egress.rules where id = $1")) {
      const row = this.rules.find((r) => String(r.id) === params[0]);
      if (row === undefined) return done();
      this.rules = this.rules.filter((r) => r !== row);
      return done([{ ...row }]);
    }
    if (text.includes("from egress.rules_history")) {
      const [limit, kind, ref] = params as [number, string | null, string | null];
      return done(
        [...this.history]
          .filter(
            (row) => (kind === null || row.kind === kind) && (ref === null || row.ref === ref),
          )
          .reverse()
          .slice(0, limit),
      );
    }
    // deletion.ts `profilesReferring` (the rule set delete)
    if (text.includes("from inbox.profiles p") && text.includes("definition->'egressRuleSets'")) {
      return done(
        [...this.profiles]
          .filter(([, sets]) => sets.includes(String(params[0])))
          .map(([name]) => ({ name, version: 1 })),
      );
    }
    // profiles.ts `readProfile` (explain)
    if (text.includes("from inbox.profiles p join inbox.profile_versions v")) {
      const sets = this.profiles.get(String(params[0]));
      return done(
        sets === undefined
          ? []
          : [
              {
                name: params[0],
                current_version: 1,
                revision: 1,
                enabled_for_new: true,
                definition: { egressRuleSets: sets },
                created_at: new Date(0),
                created_by: "seed",
                updated_at: new Date(0),
                updated_by: "seed",
              },
            ],
      );
    }
    return Promise.reject(new Error(`FakeEgressDb: unexpected statement ${text.slice(0, 60)}`));
  }
}
