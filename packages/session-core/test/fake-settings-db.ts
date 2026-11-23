import { EventEmitter } from "node:events";
import type pg from "pg";
import { FakeEgressDb } from "./fake-egress-db.ts";

interface Row {
  default_model: string;
  allowlist: unknown;
  default_reasoning: string | null;
  max_reasoning: string | null;
  default_profile: string | null;
  turn_budget: number;
  token_budget: string | null;
  repo_allowlist: unknown;
  revision: number;
  updated_at: Date;
  updated_by: string;
}

interface HistoryRow {
  id: string;
  changed_at: Date;
  changed_by: string;
  old: unknown;
  new: unknown;
}

export interface McpRow {
  name: string;
  url: string;
  transport: string;
  enabled: boolean;
  read_only: boolean;
  timeout_ms: number;
  max_output_bytes: number;
  onecli_secret: string | null;
  revision?: number;
  source?: unknown;
  created_at: Date;
  created_by: string;
  updated_at: Date;
  updated_by: string;
}

interface McpHistoryRow {
  id: string;
  changed_at: Date;
  changed_by: string;
  name: string;
  action: string;
  old: unknown;
  new: unknown;
}

export interface ProfileRowF {
  name: string;
  current_version: number;
  revision?: number;
  enabled_for_new: boolean;
  created_at: Date;
  created_by: string;
  updated_at: Date;
  updated_by: string;
}

export interface ProfileVersionRowF {
  name: string;
  version: number;
  definition: unknown;
  created_at: Date;
  created_by: string;
}

export interface SkillRowF {
  name: string;
  current_version: number;
  created_at: Date;
  created_by: string;
  updated_at: Date;
  updated_by: string;
}

export interface SkillVersionRowF {
  name: string;
  version: number;
  description: string;
  disable_model_invocation: boolean;
  digest: string;
  size_bytes: number;
  manifest: unknown;
  source?: unknown;
  created_at: Date;
  created_by: string;
}

export interface SkillFileRowF {
  name: string;
  version: number;
  path: string;
  content: Buffer;
}

/**
 * An in-memory stand-in for inbox.settings, inbox.settings_history, inbox.mcp_servers and its history that answers only
 * the statements settings.ts and mcp-servers.ts issue (the same approach as the ingest FakeInboxDb). `begin` snapshots and `rollback` restores;
 * notifications are delivered to listening clients at `commit`, like Postgres does.
 */
export class FakeSettingsDb {
  row: Row | undefined;
  readonly history: HistoryRow[] = [];
  /** Statements run, first line only. */
  readonly statements: string[] = [];
  /** Makes the next settings select throw, as a lost connection would. */
  failReads = false;
  readonly listeners = new Set<FakeListener>();
  /** inbox.shard_status's published MCP discovery outcomes, by shard. */
  mcpDiscovery: { shard: number; mcpDiscovery: Record<string, unknown> | null }[] = [];

  /** inbox.mcp_servers by name, and its history. */
  mcp = new Map<string, McpRow>();
  /** Advisory transaction locks by key, and the client that holds each. */
  readonly locks = new Map<string, FakeListener>();
  /** Shared advisory transaction locks by key, and the clients that hold each. */
  readonly sharedLocks = new Map<string, Set<FakeListener>>();
  readonly mcpHistory: McpHistoryRow[] = [];
  /** Names of the rule sets in egress.rule_sets, which profile writes check `egressRuleSets` against. */
  egressRuleSets = new Set<string>();
  /** Raw rows of egress.rule_sets and egress.rules that `readEgress` returns (network mode checks, ADR 0038). */
  egressRows: { rule_sets: unknown[]; rules: unknown[] } = { rule_sets: [], rules: [] };
  /** inbox.profiles and inbox.profile_versions; `coding` version 1 is what migration 008 seeds. */
  profiles = new Map<string, ProfileRowF>([
    [
      "coding",
      {
        name: "coding",
        current_version: 1,
        revision: 1,
        enabled_for_new: true,
        created_at: new Date(0),
        created_by: "seed",
        updated_at: new Date(0),
        updated_by: "seed",
      },
    ],
  ]);
  versions: ProfileVersionRowF[] = [
    { name: "coding", version: 1, definition: {}, created_at: new Date(0), created_by: "seed" },
  ];
  /** inbox.skills, inbox.skill_versions and inbox.skill_version_files (migration 010). */
  skills = new Map<string, SkillRowF>();
  skillVersions: SkillVersionRowF[] = [];
  skillFiles: SkillFileRowF[] = [];
  /** inbox.orchestrator_capabilities (one row) once an orchestrator published. */
  capabilities:
    | {
        tools: unknown;
        extensions: unknown;
        instance: string;
        models?: unknown;
        model_providers?: unknown;
        onecli_secret_names?: unknown;
      }
    | undefined;
  /** inbox.sessions rows by id, as the columns the profile code writes and reads. */
  sessions = new Map<string, Record<string, unknown>>();
  /** inbox.deleted_names (migration 019). */
  deletedNames: { kind: string; name: string; last_version: number | null; deleted_by: string }[] =
    [];
  /** `set local pi.allow_delete = 'on'` ran in the open transaction: the version triggers allow a delete. */
  #allowDelete = false;
  #pending: string[] = [];
  #snapshot:
    | {
        row: Row | undefined;
        history: HistoryRow[];
        mcp: Map<string, McpRow>;
        mcpHistory: McpHistoryRow[];
        profiles: Map<string, ProfileRowF>;
        versions: ProfileVersionRowF[];
        skills: Map<string, SkillRowF>;
        skillVersions: SkillVersionRowF[];
        skillFiles: SkillFileRowF[];
        deletedNames: FakeSettingsDb["deletedNames"];
      }
    | undefined;

  asPool(): pg.Pool {
    return this as unknown as pg.Pool;
  }

  /** Sets the row as a writer would, without notifying. */
  setRow(partial: Partial<Row> = {}): void {
    this.row = {
      default_model: "scripted/scripted-1",
      allowlist: ["scripted/scripted-1", "scripted/scripted-2"],
      default_reasoning: null,
      max_reasoning: null,
      default_profile: null,
      turn_budget: 100,
      token_budget: null,
      repo_allowlist: [],
      revision: 1,
      updated_at: new Date(0),
      updated_by: "seed",
      ...partial,
    };
  }

  /**
   * The `egress` schema behind the catalog writes: the MCP catalog derives its egress rules in its own transaction (ADR
   * 0040), so a catalog write issues egress statements, answered here by the egress fake and committed or rolled back with
   * the catalog write.
   */
  readonly egress = new FakeEgressDb();

  /** What `pg_notify` of a committed writer does. */
  notify(channel = "pi_settings"): void {
    for (const listener of this.listeners) {
      if (listener.channels.has(channel)) listener.emit("notification", { channel });
    }
  }

  connect(): Promise<FakeListener> {
    return Promise.resolve(new FakeListener(this));
  }

  query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    this.statements.push(sql.trim().split("\n")[0] ?? "");
    const done = (rows: unknown[] = []) => Promise.resolve({ rows, rowCount: rows.length });
    const text = sql.replace(/\s+/g, " ").trim();
    if (text === "begin" || text === "commit" || text === "rollback") {
      void this.egress.query(text);
    }
    if (text === "begin") {
      this.#snapshot = {
        row: this.row === undefined ? undefined : { ...this.row },
        history: [...this.history],
        mcp: new Map([...this.mcp].map(([name, row]) => [name, { ...row }])),
        mcpHistory: [...this.mcpHistory],
        profiles: new Map([...this.profiles].map(([name, row]) => [name, { ...row }])),
        versions: this.versions.map((row) => ({ ...row })),
        skills: new Map([...this.skills].map(([name, row]) => [name, { ...row }])),
        skillVersions: this.skillVersions.map((row) => ({ ...row })),
        skillFiles: [...this.skillFiles],
        deletedNames: [...this.deletedNames],
      };
      return done();
    }
    if (text === "commit") {
      this.#snapshot = undefined;
      this.#allowDelete = false;
      const sent = this.#pending;
      this.#pending = [];
      for (const channel of new Set(sent)) this.notify(channel);
      return done();
    }
    if (text === "rollback") {
      if (this.#snapshot !== undefined) {
        this.row = this.#snapshot.row;
        this.history.splice(0, this.history.length, ...this.#snapshot.history);
        this.mcp = this.#snapshot.mcp;
        this.mcpHistory.splice(0, this.mcpHistory.length, ...this.#snapshot.mcpHistory);
        this.profiles = this.#snapshot.profiles;
        this.versions = this.#snapshot.versions;
        this.skills = this.#snapshot.skills;
        this.skillVersions = this.#snapshot.skillVersions;
        this.skillFiles = this.#snapshot.skillFiles;
        this.deletedNames = this.#snapshot.deletedNames;
      }
      this.#allowDelete = false;
      this.#snapshot = undefined;
      this.#pending = [];
      return done();
    }
    // A refused statement rejects, as node-postgres does; it never throws synchronously.
    let deletion: Promise<{ rows: unknown[]; rowCount: number }> | undefined;
    try {
      deletion = this.#deletionQuery(text, params, done);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    if (deletion !== undefined) return deletion;
    if (text.startsWith("select shard, configured_runtime")) return done([]);
    // What the derivation of the MCP rules reads and writes (egress-mcp-rules.ts): the egress fake answers.
    if (
      /^(select (name|id, host, ports, route, note|system) from egress\.|insert into egress\.(rules|rule_sets|revisions|rules_history)|update egress\.rules|delete from egress\.rules where id)/.test(
        text,
      )
    ) {
      return this.egress.query(sql, params);
    }
    if (text.includes("from egress.revisions")) {
      return done([{ revision: 0, ...this.egressRows }]);
    }
    if (text.startsWith("select count(*) as n from inbox.sessions where network_mode = 'direct'")) {
      return done([
        {
          n: String([...this.sessions.values()].filter((r) => r.network_mode === "direct").length),
        },
      ]);
    }
    if (text.startsWith("select name, system from egress.rule_sets")) {
      return done(
        (params[0] as string[])
          .filter((name) => this.egressRuleSets.has(name))
          .map((name) => ({ name, system: name === "mcp-catalog" })),
      );
    }
    if (text.includes("from inbox.events where session_id")) return done([]);
    if (text.includes("mcp_discovery as") && text.includes("from inbox.shard_status")) {
      return done(this.mcpDiscovery.map((row) => ({ ...row })));
    }
    if (text.includes("inbox.mcp_servers")) return this.#mcpQuery(text, params, done);
    if (/inbox\.skill/.test(text)) return this.#skillQuery(text, params, done);
    if (/inbox\.(profiles|profile_versions|orchestrator_capabilities|sessions)\b/.test(text)) {
      return this.#profileQuery(text, params, done);
    }
    if (text.startsWith("select default_profile from inbox.settings")) {
      return done(this.row === undefined ? [] : [{ default_profile: this.row.default_profile }]);
    }
    if (text.startsWith("select default_model")) {
      if (this.failReads) return Promise.reject(new Error("connection lost"));
      return done(this.row === undefined ? [] : [{ ...this.row }]);
    }
    if (text.startsWith("insert into inbox.settings (")) {
      const [model, list, reasoning, maxReasoning, defaultProfile, budget, tokens, repos, by] =
        params as [
          string,
          string,
          string | null,
          string | null,
          string | null,
          number,
          number | null,
          string,
          string | undefined,
        ];
      const next: Row = {
        default_model: model,
        allowlist: JSON.parse(list) as unknown,
        default_reasoning: reasoning,
        max_reasoning: maxReasoning,
        default_profile: defaultProfile,
        turn_budget: budget,
        // node-postgres returns a bigint as a string.
        token_budget: tokens === null ? null : String(tokens),
        repo_allowlist: JSON.parse(repos) as unknown,
        revision: text.includes("do nothing") ? 1 : (this.row?.revision ?? 0) + 1,
        updated_at: new Date(),
        updated_by: by ?? "seed",
      };
      if (text.includes("do nothing")) {
        if (this.row !== undefined) return done();
        this.row = next;
        return done([{ default_model: model }]);
      }
      this.row = next;
      return done([{ ...next }]);
    }
    if (text.startsWith("insert into inbox.settings_history")) {
      const [by, old, next] = params as [string, string | null, string];
      this.history.push({
        id: String(this.history.length + 1),
        changed_at: new Date(),
        changed_by: by,
        old: old === null ? null : (JSON.parse(old) as unknown),
        new: JSON.parse(next) as unknown,
      });
      return done();
    }
    if (text.startsWith("select pg_notify") && params[0] === "egress_rules") {
      return this.egress.query(sql, params);
    }
    if (text.startsWith("select pg_notify")) {
      this.#pending.push(String(params[0]));
      return done();
    }
    if (text.startsWith("select id, changed_at")) {
      return done([...this.history].reverse().slice(0, Number(params[0])));
    }
    throw new Error(`FakeSettingsDb: unexpected statement ${text.slice(0, 60)}`);
  }

  #profileJoin(): (ProfileRowF & { definition: unknown })[] {
    return [...this.profiles.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((profile) => {
        const version = this.versions.find(
          (v) => v.name === profile.name && v.version === profile.current_version,
        );
        return version === undefined ? [] : [{ ...profile, definition: version.definition }];
      });
  }

  /** The statements of skills.ts. */
  #skillQuery(
    text: string,
    params: unknown[],
    done: (rows?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>,
  ) {
    if (this.failReads && text.startsWith("select")) {
      return Promise.reject(new Error("connection lost"));
    }
    if (text.startsWith("select s.name")) {
      const rows = [...this.skills.values()]
        .sort((a, b) => (a.name < b.name ? -1 : 1))
        .filter((skill) => !text.includes("where s.name = $1") || skill.name === params[0])
        .flatMap((skill) => {
          const v = this.skillVersions.find(
            (row) => row.name === skill.name && row.version === skill.current_version,
          );
          return v === undefined
            ? []
            : [
                {
                  ...v,
                  current_version: skill.current_version,
                  s_created_at: skill.created_at,
                  s_created_by: skill.created_by,
                  s_updated_at: skill.updated_at,
                  s_updated_by: skill.updated_by,
                },
              ];
        });
      return done(rows);
    }
    if (text.startsWith("select name, version, description")) {
      const rows = this.skillVersions
        .filter((v) => v.name === params[0] && (params[1] === undefined || v.version === params[1]))
        .sort((a, b) => b.version - a.version)
        .map((v) => ({ ...v }));
      return done(rows);
    }
    if (text.startsWith("select path, content")) {
      return done(
        this.skillFiles
          .filter((f) => f.name === params[0] && f.version === params[1])
          .map((f) => ({ path: f.path, content: f.content })),
      );
    }
    if (text.startsWith("insert into inbox.skills (")) {
      const [name, by] = params as [string, string];
      if (this.skills.has(name)) throw new Error("duplicate key value (skills)");
      const now = new Date();
      this.skills.set(name, {
        name,
        current_version: 1,
        created_at: now,
        created_by: by,
        updated_at: now,
        updated_by: by,
      });
      return done();
    }
    if (text.startsWith("insert into inbox.skill_versions")) {
      const [name, version, description, disableModelInvocation, digest, size, manifest, by, src] =
        params as [string, number, string, boolean, string, number, string, string, string | null];
      if (!this.skills.has(name)) throw new Error("foreign key violation (skill_versions)");
      if (this.skillVersions.some((v) => v.name === name && v.version === version)) {
        throw new Error("duplicate key value (skill_versions)");
      }
      this.skillVersions.push({
        name,
        version,
        description,
        disable_model_invocation: disableModelInvocation,
        digest,
        size_bytes: size,
        manifest: JSON.parse(manifest) as unknown,
        source: src === null ? null : (JSON.parse(src) as unknown),
        created_at: new Date(),
        created_by: by,
      });
      return done();
    }
    if (text.startsWith("insert into inbox.skill_version_files")) {
      const [name, version, path, content] = params as [string, number, string, Buffer];
      this.skillFiles.push({ name, version, path, content });
      return done();
    }
    if (text.startsWith("update inbox.skills set")) {
      const [name, version, by] = params as [string, number, string];
      const row = this.skills.get(name);
      if (row !== undefined) {
        Object.assign(row, { current_version: version, updated_at: new Date(), updated_by: by });
      }
      return done();
    }
    throw new Error(`FakeSettingsDb: unexpected skill statement ${text.slice(0, 60)}`);
  }

  /** The statements of deletion.ts and the three deletes (ADR 0027); undefined for any other statement. */
  #deletionQuery(
    text: string,
    params: unknown[],
    done: (rows?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>,
  ): Promise<{ rows: unknown[]; rowCount: number }> | undefined {
    const versionDelete = (table: string) => {
      // The immutability triggers of migrations 008 and 010, as amended by 019.
      if (!this.#allowDelete) throw new Error(`${table} rows are immutable`);
    };
    if (text === "set local pi.allow_delete = 'on'") {
      this.#allowDelete = true;
      return done();
    }
    if (text.startsWith("select 1 from inbox.deleted_names")) {
      const [kind, name] = params as [string, string];
      return done(
        this.deletedNames.filter((d) => d.kind === kind && d.name === name).map(() => ({})),
      );
    }
    if (text.startsWith("select name from inbox.deleted_names")) {
      const [kind, names] = params as [string, string[]];
      return done(
        this.deletedNames
          .filter((d) => d.kind === kind && names.includes(d.name))
          .map((d) => ({ name: d.name }))
          .sort((a, b) => (a.name < b.name ? -1 : 1)),
      );
    }
    if (text.startsWith("insert into inbox.deleted_names")) {
      const [kind, name, lastVersion, by] = params as [string, string, number | null, string];
      if (this.deletedNames.some((d) => d.kind === kind && d.name === name)) {
        throw new Error("duplicate key value (deleted_names)");
      }
      this.deletedNames.push({ kind, name, last_version: lastVersion, deleted_by: by });
      return done();
    }
    if (text.startsWith("select p.name, p.current_version as version from inbox.profiles p")) {
      const [name] = params as [string];
      const bySkill = text.includes("'skills'");
      return done(
        [...this.profiles.values()]
          .filter((p) => {
            const v = this.versions.find(
              (row) => row.name === p.name && row.version === p.current_version,
            );
            const definition = (v?.definition ?? {}) as {
              skills?: { name: string }[];
              mcpServers?: string[];
            };
            return bySkill
              ? (definition.skills ?? []).some((ref) => ref.name === name)
              : (definition.mcpServers ?? []).includes(name);
          })
          .sort((a, b) => (a.name < b.name ? -1 : 1))
          .map((p) => ({ name: p.name, version: p.current_version })),
      );
    }
    if (
      text.startsWith(
        "select p.name, case when v.definition->>'sandboxFlavour' in ('browser', 'desktop')",
      )
    ) {
      const [name] = params as [string];
      return done(
        [...this.profiles.values()]
          .sort((a, b) => (a.name < b.name ? -1 : 1))
          .flatMap((p) => {
            const definition = (this.versions.find(
              (row) => row.name === p.name && row.version === p.current_version,
            )?.definition ?? {}) as {
              mcpServers?: string[];
              sandboxFlavour?: string;
              networkMode?: string;
            };
            const flavour =
              definition.sandboxFlavour === "browser" || definition.sandboxFlavour === "desktop"
                ? definition.sandboxFlavour
                : null;
            const direct = definition.networkMode === "direct";
            return (definition.mcpServers ?? []).includes(name) && (flavour !== null || direct)
              ? [{ name: p.name, flavour, direct }]
              : [];
          }),
      );
    }
    if (text.startsWith("select id, count(*) over () as total from inbox.sessions")) {
      const [name] = params as [string];
      const pinning = [...this.sessions.values()]
        .filter((row) => row.status !== "deleted")
        .filter((row) => {
          const snapshot = row.profile_snapshot as { skills?: { name: string }[] } | null;
          return (snapshot?.skills ?? []).some((ref) => ref.name === name);
        })
        .sort((a, b) => (a.created_at as Date).getTime() - (b.created_at as Date).getTime());
      return done(pinning.slice(0, 5).map((row) => ({ id: row.id, total: pinning.length })));
    }
    if (text.startsWith("select current_version, revision, enabled_for_new from inbox.profiles")) {
      const row = this.profiles.get(String(params[0]));
      return done(
        row === undefined
          ? []
          : [
              {
                current_version: row.current_version,
                revision: row.revision ?? 1,
                enabled_for_new: row.enabled_for_new,
              },
            ],
      );
    }
    if (text.startsWith("select current_version from inbox.skills where name = $1")) {
      const row = this.skills.get(String(params[0]));
      return done(row === undefined ? [] : [{ current_version: row.current_version }]);
    }
    if (text === "delete from inbox.profile_versions where name = $1") {
      versionDelete("inbox.profile_versions");
      this.versions = this.versions.filter((v) => v.name !== params[0]);
      return done();
    }
    if (text === "delete from inbox.profiles where name = $1") {
      if (this.versions.some((v) => v.name === params[0])) {
        throw new Error("foreign key violation (profile_versions)");
      }
      this.profiles.delete(String(params[0]));
      return done();
    }
    if (text === "delete from inbox.skill_version_files where name = $1") {
      versionDelete("skill_version_files");
      this.skillFiles = this.skillFiles.filter((f) => f.name !== params[0]);
      return done();
    }
    if (text === "delete from inbox.skill_versions where name = $1") {
      versionDelete("skill_versions");
      if (this.skillFiles.some((f) => f.name === params[0])) {
        throw new Error("foreign key violation (skill_version_files)");
      }
      this.skillVersions = this.skillVersions.filter((v) => v.name !== params[0]);
      return done();
    }
    if (text === "delete from inbox.skills where name = $1") {
      if (this.skillVersions.some((v) => v.name === params[0])) {
        throw new Error("foreign key violation (skill_versions)");
      }
      this.skills.delete(String(params[0]));
      return done();
    }
    return undefined;
  }

  /** The statements of profiles.ts and the session insert and select that carry the profile snapshot. */
  #profileQuery(
    text: string,
    params: unknown[],
    done: (rows?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>,
  ) {
    if (this.failReads && text.startsWith("select")) {
      return Promise.reject(new Error("connection lost"));
    }
    if (text.startsWith("select p.name")) {
      const all = this.#profileJoin();
      return done(
        text.includes("where p.name = $1") ? all.filter((p) => p.name === params[0]) : all,
      );
    }
    if (text.startsWith("select version, definition")) {
      return done(
        this.versions
          .filter((v) => v.name === params[0])
          .sort((a, b) => b.version - a.version)
          .map((v) => ({ ...v })),
      );
    }
    if (text.startsWith("insert into inbox.profiles (")) {
      const [name, enabled, by] = params as [string, boolean, string];
      if (this.profiles.has(name)) throw new Error("duplicate key value (profiles)");
      const now = new Date();
      this.profiles.set(name, {
        name,
        current_version: 1,
        revision: 1,
        enabled_for_new: enabled,
        created_at: now,
        created_by: by,
        updated_at: now,
        updated_by: by,
      });
      return done();
    }
    if (text.startsWith("insert into inbox.profile_versions")) {
      const [name, version, definition, by] = params as [string, number, string, string];
      if (!this.profiles.has(name)) throw new Error("foreign key violation (profile_versions)");
      if (this.versions.some((v) => v.name === name && v.version === version)) {
        throw new Error("duplicate key value (profile_versions)");
      }
      this.versions.push({
        name,
        version,
        definition: JSON.parse(definition) as unknown,
        created_at: new Date(),
        created_by: by,
      });
      return done();
    }
    if (text.startsWith("update inbox.profiles set")) {
      const [name, version, enabled, by] = params as [string, number, boolean, string];
      const row = this.profiles.get(name);
      if (row === undefined) return done();
      Object.assign(row, {
        current_version: version,
        revision: (row.revision ?? 0) + 1,
        enabled_for_new: enabled,
        updated_at: new Date(),
        updated_by: by,
      });
      return done();
    }
    if (text.startsWith("select tools, extensions")) {
      return done(this.capabilities === undefined ? [] : [{ ...this.capabilities }]);
    }
    if (text.startsWith("insert into inbox.orchestrator_capabilities")) {
      const [tools, extensions, instance, models, providers, secretNames] = params as [
        string,
        string,
        string,
        string | null,
        string | null,
        string | null | undefined,
      ];
      this.capabilities = {
        tools: JSON.parse(tools) as unknown,
        extensions: JSON.parse(extensions) as unknown,
        instance,
        models: models === null ? null : (JSON.parse(models) as unknown),
        model_providers: providers === null ? null : (JSON.parse(providers) as unknown),
        onecli_secret_names:
          secretNames === null || secretNames === undefined
            ? null
            : (JSON.parse(secretNames) as unknown),
      };
      return done();
    }
    if (text.startsWith("update inbox.orchestrator_capabilities set onecli_secret_names")) {
      const [names] = params as [string];
      const next = JSON.parse(names) as unknown;
      if (
        this.capabilities === undefined ||
        JSON.stringify(this.capabilities.onecli_secret_names) === JSON.stringify(next)
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      this.capabilities = { ...this.capabilities, onecli_secret_names: next };
      return Promise.resolve({ rows: [], rowCount: 1 });
    }
    if (text.startsWith("update inbox.orchestrator_capabilities set model_providers")) {
      const [providers] = params as [string];
      const next = JSON.parse(providers) as unknown;
      if (
        this.capabilities === undefined ||
        JSON.stringify(this.capabilities.model_providers) === JSON.stringify(next)
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      this.capabilities = { ...this.capabilities, model_providers: next };
      return Promise.resolve({ rows: [], rowCount: 1 });
    }
    if (text.startsWith("insert into inbox.sessions (")) {
      const [id, owner, subject, provider, model, reasoning, repo, branch, pName, pVersion, pSnap] =
        params as (string | null)[];
      const sandboxSize = (params[12] ?? null) as string | null;
      const networkMode = (params[13] ?? null) as string | null;
      const sandboxFlavour = (params[14] ?? null) as string | null;
      const sandboxRuntime = (params[15] ?? null) as string | null;
      const liveViewToken = (params[16] ?? null) as string | null;
      if (pName !== null) {
        // Only while the profile is still at the snapshot's version and open to new sessions (store.ts).
        const current = this.profiles.get(String(pName));
        if (
          current === undefined ||
          current.current_version !== Number(pVersion) ||
          !current.enabled_for_new
        ) {
          return done([]);
        }
      }
      this.sessions.set(String(id), {
        id,
        owner,
        owner_subject: subject,
        status: "active",
        shard: 0,
        conversation_id: null,
        model_provider: provider,
        model_id: model,
        model_reasoning: reasoning,
        failure: null,
        repo,
        repo_branch: branch,
        onecli_agent_id: null,
        onecli_secret_ids: null,
        workspace_ready_at: null,
        profile_name: pName,
        profile_version: pVersion,
        profile_snapshot: pSnap === null ? null : (JSON.parse(String(pSnap)) as unknown),
        sandbox_size: sandboxSize,
        network_mode: networkMode,
        sandbox_flavour: sandboxFlavour,
        sandbox_runtime: sandboxRuntime,
        live_view_token: liveViewToken,
        created_at: new Date(),
        last_activity_at: new Date(),
      });
      return done([{ id }]);
    }
    if (text.startsWith("select * from inbox.sessions where shard = $1 and conversation_id = $2")) {
      return done(
        [...this.sessions.values()]
          .filter((row) => row.shard === params[0] && row.conversation_id === params[1])
          .map((row) => ({ ...row })),
      );
    }
    if (text.startsWith("select * from inbox.sessions where live_view_token = $1")) {
      return done(
        [...this.sessions.values()]
          .filter((row) => row.live_view_token === params[0])
          .map((row) => ({ ...row })),
      );
    }
    // store.ts `setLiveViewToken`: a token is stored only on an active session; null (off) always.
    if (text.startsWith("update inbox.sessions set live_view_token = $2")) {
      const row = this.sessions.get(String(params[0]));
      if (row === undefined || (params[1] !== null && row.status !== "active")) return done([]);
      row.live_view_token = params[1];
      return done([{}]);
    }
    if (text.startsWith("select * from inbox.sessions")) {
      const row = this.sessions.get(String(params[0]));
      return done(row === undefined ? [] : [{ ...row }]);
    }
    throw new Error(`FakeSettingsDb: unexpected profile statement ${text.slice(0, 60)}`);
  }

  /** The statements of mcp-servers.ts, matched by their first words. */
  #mcpQuery(
    text: string,
    params: unknown[],
    done: (rows?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>,
  ) {
    if (this.failReads && text.startsWith("select")) {
      return Promise.reject(new Error("connection lost"));
    }
    if (text.startsWith("select name, url")) {
      if (text.includes("where name = $1")) {
        const row = this.mcp.get(String(params[0]));
        return done(row === undefined ? [] : [{ ...row }]);
      }
      return done(
        [...this.mcp.values()].sort((a, b) => a.name.localeCompare(b.name)).map((r) => ({ ...r })),
      );
    }
    if (text.startsWith("insert into inbox.mcp_servers (")) {
      const [name, url, transport, enabled, readOnly, timeoutMs, maxOut, secret, src, by] =
        params as [
          string,
          string,
          string,
          boolean,
          boolean,
          number,
          number,
          string | null,
          string | null,
          string,
        ];
      const before = this.mcp.get(name);
      const now = new Date();
      const row: McpRow = {
        name,
        url,
        transport,
        enabled,
        read_only: readOnly,
        timeout_ms: timeoutMs,
        max_output_bytes: maxOut,
        onecli_secret: secret,
        revision: (before?.revision ?? 0) + 1,
        source: src === null ? null : (JSON.parse(src) as unknown),
        created_at: before?.created_at ?? now,
        created_by: before?.created_by ?? by,
        updated_at: now,
        updated_by: by,
      };
      this.mcp.set(name, row);
      return done([{ ...row }]);
    }
    if (text.startsWith("delete from inbox.mcp_servers")) {
      const row = this.mcp.get(String(params[0]));
      this.mcp.delete(String(params[0]));
      return done(row === undefined ? [] : [{ ...row }]);
    }
    if (text.startsWith("insert into inbox.mcp_servers_history")) {
      const [by, name, action, old, next] = params as [
        string,
        string,
        string,
        string | null,
        string | null,
      ];
      this.mcpHistory.push({
        id: String(this.mcpHistory.length + 1),
        changed_at: new Date(),
        changed_by: by,
        name,
        action,
        old: old === null ? null : (JSON.parse(old) as unknown),
        new: next === null ? null : (JSON.parse(next) as unknown),
      });
      return done();
    }
    if (text.startsWith("select id, changed_at, changed_by, name")) {
      const [limit, name] = params as [number, string | null];
      return done(
        [...this.mcpHistory]
          .filter((entry) => name === null || entry.name === name)
          .reverse()
          .slice(0, limit),
      );
    }
    throw new Error(`FakeSettingsDb: unexpected MCP statement ${text.slice(0, 60)}`);
  }
}

/** One pooled client: transaction statements go to the db; `listen` registers it for notifications. */
export class FakeListener extends EventEmitter {
  released = false;
  /** Channels this client LISTENs on. */
  readonly channels = new Set<string>();
  readonly #db: FakeSettingsDb;
  // No parameter property: the console's browser suite runs this file under Node's type stripping.
  constructor(db: FakeSettingsDb) {
    super();
    this.#db = db;
  }

  async query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> {
    if (sql.startsWith("select pg_advisory_xact_lock_shared")) {
      // Held until commit or rollback; waits only for another client's exclusive lock on the key.
      const key = String(params?.[0]);
      while (this.#db.locks.has(key) && this.#db.locks.get(key) !== this) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      const holders = this.#db.sharedLocks.get(key) ?? new Set<FakeListener>();
      holders.add(this);
      this.#db.sharedLocks.set(key, holders);
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("select pg_advisory_xact_lock")) {
      // Held until this client commits or rolls back; a second client asking for the same key waits, and so does a
      // client asking while others hold it shared.
      const key = String(params?.[0]);
      const sharedByOthers = () =>
        [...(this.#db.sharedLocks.get(key) ?? [])].some((holder) => holder !== this);
      while ((this.#db.locks.has(key) && this.#db.locks.get(key) !== this) || sharedByOthers()) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      this.#db.locks.set(key, this);
      return { rows: [], rowCount: 0 };
    }
    if (sql === "commit" || sql === "rollback") {
      const result = await this.#db.query(sql, params);
      for (const [key, holder] of this.#db.locks) if (holder === this) this.#db.locks.delete(key);
      for (const holders of this.#db.sharedLocks.values()) holders.delete(this);
      return result;
    }
    if (sql.startsWith("listen ")) {
      this.channels.add(sql.slice("listen ".length).trim());
      this.#db.listeners.add(this);
      return { rows: [], rowCount: 0 };
    }
    return this.#db.query(sql, params);
  }

  release(): void {
    // node-postgres throws on a second release; the fake must too.
    if (this.released)
      throw new Error("Release called on client which has already been released to the pool.");
    this.released = true;
    this.#db.listeners.delete(this);
  }

  /** The server dropped the connection. */
  drop(): void {
    this.#db.listeners.delete(this);
    this.emit("error", new Error("terminating connection"));
  }
}
