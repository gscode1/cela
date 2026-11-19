import { describe, expect, it } from "vitest";
import type { EgressStatus } from "@/lib/api/egress";
import type { McpCatalog, McpServer } from "@/lib/api/mcp";
import type { ModelCatalog } from "@/lib/api/models";
import type { ShardStatus, StatusReport } from "@/lib/api/status";
import { hasProblem, statusRows } from "@/lib/status-rows";
import type { Source, StatusInputs, StatusRow } from "@/lib/status-rows";

const ok = <T>(data: T): Source<T> => ({ state: "ok", data });

const shard = (over: Partial<ShardStatus> = {}): ShardStatus => ({
  shard: 0,
  configuredRuntime: "gvisor",
  observedRuntime: "gvisor",
  networkPolicy: "enforced",
  networkPolicyCheckedAt: "2026-11-19T00:00:00.000Z",
  networkPolicyDetail: null,
  probeRequestedAt: null,
  updatedAt: "2026-11-19T00:00:00.000Z",
  ...over,
});

const report = (shards: ShardStatus[], over: Partial<StatusReport> = {}): StatusReport => ({
  shards,
  networkPolicy: null,
  ...over,
});

const egress = (over: Partial<EgressStatus> = {}): EgressStatus => ({
  revision: 3,
  ruleSets: 1,
  rules: 2,
  invalid: 0,
  proxy: { replicas: [{ name: "proxy-0", revision: 3, state: "serving" }] },
  ...over,
});

const models = (over: Partial<ModelCatalog> = {}): ModelCatalog => ({
  models: [],
  providers: [{ provider: "openai", credential: "configured" }],
  source: "orchestrator",
  filtered: true,
  credentials: "configured",
  ...over,
});

const server = (name: string, over: Partial<McpServer> = {}): McpServer => ({
  name,
  url: `https://${name}.example.com/mcp`,
  transport: "streamable-http",
  enabled: true,
  readOnly: true,
  timeoutMs: 60_000,
  maxOutputBytes: 24_576,
  onecliSecret: null,
  revision: 1,
  source: null,
  reachability: "ok",
  createdAt: "2026-11-19T00:00:00.000Z",
  createdBy: "a",
  updatedAt: "2026-11-19T00:00:00.000Z",
  updatedBy: "a",
  ...over,
});

const mcp = (servers: McpServer[], over: Partial<McpCatalog> = {}): McpCatalog => ({
  servers,
  invalid: [],
  ...over,
});

const inputs = (over: Partial<StatusInputs> = {}): StatusInputs => ({
  status: ok(report([shard()])),
  egress: ok(egress()),
  models: ok(models()),
  mcp: ok(
    mcp([server("github")], { onecliSecrets: { names: ["a", "b"], source: "orchestrator" } }),
  ),
  ...over,
});

const row = (rows: StatusRow[], id: StatusRow["id"]): StatusRow => {
  const found = rows.find((r) => r.id === id);
  if (found === undefined) throw new Error(`no row ${id}`);
  return found;
};

describe("status rows", () => {
  it("is all good: one green line per area and no direct sessions row", () => {
    const rows = statusRows(inputs());
    expect(rows.map((r) => r.id).sort()).toEqual(
      ["egress", "mcp", "network", "onecli", "runtime", "shards"].sort(),
    );
    expect(rows.every((r) => r.level === "ok")).toBe(true);
    expect(row(rows, "runtime").sentence).toBe("Sandboxes run under gVisor.");
    expect(row(rows, "shards").sentence).toBe("1 shard reported.");
    expect(row(rows, "egress").sentence).toBe("1 replica serving, in sync.");
    expect(row(rows, "mcp").sentence).toBe("1 ready, 0 failing");
    expect(hasProblem(rows)).toBe(false);
  });

  it("says a shard's report is a last report, never up, and OneCLI is never up or down", () => {
    const rows = statusRows(inputs());
    expect(row(rows, "shards").when?.label).toBe("last report");
    const text = rows.map((r) => r.sentence).join(" ");
    expect(text).not.toMatch(/\b(up|down)\b/i);
  });

  it("names the shard whose runtime differs, and a runtime not observed yet", () => {
    const mismatch = statusRows(
      inputs({ status: ok(report([shard(), shard({ shard: 1, observedRuntime: "" })])) }),
    );
    expect(row(mismatch, "runtime")).toMatchObject({
      level: "problem",
      sentence: "Shard 1: configured gvisor, observed node default.",
    });
    expect(mismatch[0]?.id).toBe("runtime");
    const fresh = statusRows(inputs({ status: ok(report([shard({ observedRuntime: null })])) }));
    expect(row(fresh, "runtime").level).toBe("attention");
    expect(row(fresh, "runtime").sentence).toMatch(/^Not observed yet/);
    const several = statusRows(
      inputs({
        status: ok(
          report([shard(), shard({ shard: 1 }), shard({ shard: 2, observedRuntime: null })]),
        ),
      }),
    );
    expect(row(several, "runtime").sentence).toBe(
      "Sandboxes run under gVisor; not observed yet on shard 2.",
    );
    const all = statusRows(inputs({ status: ok(report([shard(), shard({ shard: 1 })])) }));
    expect(row(all, "runtime").sentence).toBe("Sandboxes run under gVisor on all shards.");
  });

  it("reads network isolation once for the cluster, and sorts a problem first", () => {
    const rows = statusRows(
      inputs({
        status: ok(
          report([shard()], {
            networkPolicy: {
              state: "not-enforced",
              checkedAt: "2026-11-19T00:00:00.000Z",
              detail: { state: "not-enforced", reason: "egress succeeded" },
              requestedAt: null,
            },
          }),
        ),
      }),
    );
    expect(rows[0]).toMatchObject({ id: "network", level: "problem" });
    expect(hasProblem(rows)).toBe(true);
    const checking = statusRows(
      inputs({ status: ok(report([shard({ networkPolicy: "running" })])) }),
    );
    expect(row(checking, "network")).toMatchObject({ level: "attention", checking: true });
    const unchecked = statusRows(
      inputs({ status: ok(report([shard({ networkPolicy: "unknown" })])) }),
    );
    expect(row(unchecked, "network").sentence).toBe("Not checked since the last start.");
    const asked = statusRows(
      inputs({ status: ok(report([shard({ probeRequestedAt: "2026-11-19T00:00:00.000Z" })])) }),
    );
    expect(row(asked, "network").checking).toBe(true);
  });

  it("shows direct sessions only when there are some", () => {
    expect(
      statusRows(inputs({ status: ok(report([shard()], { directSessions: 0 })) })).map((r) => r.id),
    ).not.toContain("direct");
    const rows = statusRows(inputs({ status: ok(report([shard()], { directSessions: 2 })) }));
    expect(row(rows, "direct")).toMatchObject({
      level: "attention",
      sentence: "2 live sessions with open internet.",
    });
    expect(hasProblem(rows)).toBe(false);
  });

  it("with no report yet: attention, not verified", () => {
    const rows = statusRows(inputs({ status: ok(report([])) }));
    expect(row(rows, "runtime").level).toBe("attention");
    expect(row(rows, "shards").sentence).toBe("No shard has reported yet.");
    expect(row(rows, "network").level).toBe("attention");
  });

  it("names a stale proxy replica, and a replica behind the rules", () => {
    const stale = statusRows(
      inputs({
        egress: ok(
          egress({
            proxy: {
              replicas: [
                { name: "proxy-0", revision: 3, state: "serving" },
                { name: "proxy-1", revision: 2, state: "stale" },
              ],
            },
          }),
        ),
      }),
    );
    expect(row(stale, "egress")).toMatchObject({
      level: "problem",
      sentence: "proxy-1 is stale; 1 replica serving, in sync.",
    });
    const behind = statusRows(
      inputs({
        egress: ok(
          egress({ proxy: { replicas: [{ name: "proxy-0", revision: 2, state: "serving" }] } }),
        ),
      }),
    );
    expect(row(behind, "egress").level).toBe("attention");
    const none = statusRows(inputs({ egress: ok(egress({ proxy: { replicas: [] } })) }));
    expect(row(none, "egress")).toMatchObject({ level: "attention", sentence: "No reports yet." });
    const invalid = statusRows(inputs({ egress: ok(egress({ invalid: 2 })) }));
    expect(row(invalid, "egress").sentence).toContain("2 stored rows invalid and not evaluated");
  });

  it("counts MCP servers and names the failing ones", () => {
    const rows = statusRows(
      inputs({
        mcp: ok(
          mcp([
            server("a"),
            server("b"),
            server("broken", { reachability: "failing" }),
            server("off", { enabled: false }),
            server("new", { reachability: "unknown" }),
          ]),
        ),
      }),
    );
    expect(row(rows, "mcp")).toMatchObject({
      level: "problem",
      sentence: "2 ready, 1 failing, 1 not reported yet",
      failing: ["broken"],
    });
    expect(row(statusRows(inputs({ mcp: ok(mcp([])) })), "mcp").level).toBe("info");
  });

  it("reports OneCLI credentials and whether the secret list is known", () => {
    const known = row(statusRows(inputs()), "onecli");
    expect(known).toMatchObject({ level: "ok" });
    expect(known.sentence).toBe("Model credentials configured for openai; secret list known (2).");
    const unknown = row(
      statusRows(
        inputs({
          mcp: ok(mcp([], { onecliSecrets: { names: [], source: "none" } })),
          models: ok(models({ credentials: "unknown", reason: "no admin key", providers: [] })),
        }),
      ),
      "onecli",
    );
    expect(unknown.level).toBe("unknown");
    expect(unknown.sentence).toContain("secret list unknown");
    const none = row(
      statusRows(inputs({ models: ok(models({ credentials: "none-configured", providers: [] })) })),
      "onecli",
    );
    expect(none).toMatchObject({ level: "problem" });
  });

  it("puts a reader that failed on its own row, not on the others", () => {
    const rows = statusRows(inputs({ egress: { state: "error", message: "boom" } }));
    expect(row(rows, "egress")).toMatchObject({
      level: "unknown",
      sentence: "Could not read: boom",
      unavailable: true,
    });
    expect(row(rows, "runtime").level).toBe("ok");
    expect(hasProblem(rows)).toBe(false);
  });

  it("adds the deployment row only when asked", () => {
    expect(statusRows(inputs()).map((r) => r.id)).not.toContain("deployment");
    const rows = statusRows(
      inputs({
        deployment: {
          networkModes: ok({ modes: ["proxied"], defaultMode: "proxied", directAllowed: false }),
          flavours: ok({ flavours: ["default"], defaultFlavour: "default", browserEnabled: true }),
          sizes: ok({ sizes: [], defaultSize: null }),
          tools: ok({ tools: [], source: "orchestrator" }),
        },
      }),
    );
    expect(row(rows, "deployment").sentence).toBe(
      "Direct egress not allowed, browser image enabled, 0 sandbox sizes.",
    );
    expect(rows.at(-1)?.id).toBe("deployment");
  });
});
