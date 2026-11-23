import { describe, expect, it } from "vitest";
import { helmTemplate, renderDocs, type Obj } from "./support/helm.js";

// The public live view in charts/cela (issue #418, ADR 0066): nothing is rendered while it is off, and when it is on the
// only new openings are the orchestrator's egress to 6080 and one ingress policy that selects desktop Pods from the
// orchestrator. Parsed YAML has no static shape; every field read below is asserted on.
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call */

const chart = "cela";
const external = [
  "--set",
  "onecli.mode=external",
  "--set",
  "onecli.external.apiUrl=http://onecli.onecli:10256",
  "--set",
  "onecli.external.gatewayUrl=http://onecli.onecli:10255",
];
const desktop = [
  "--set",
  "sandbox.flavours.desktop.enabled=true",
  "--set",
  "images.sandboxDesktop.tag=test",
];
const live = [
  ...desktop,
  "--set",
  "liveView.enabled=true",
  "--set",
  "liveView.publicUrl=https://live.example.lan",
];
const route = [
  ...live,
  "--set",
  "liveView.httpRoute.enabled=true",
  "--set",
  "liveView.httpRoute.parentRefs[0].name=main",
  "--set",
  "liveView.httpRoute.hostnames[0]=live.example.lan",
  "--set",
  "networkPolicy.ingest.clients[0].namespaceSelector.matchLabels.gw=true",
];
const docs = (args: string[]): Obj[] => renderDocs(chart, [...external, ...args]);
const named = (list: Obj[], kind: string, name: string): Obj | undefined =>
  list.find((d) => d.kind === kind && d.metadata.name === name);
const env = (deployment: Obj): Record<string, string> =>
  Object.fromEntries(
    deployment.spec.template.spec.containers[0].env.map((e: Obj) => [e.name, e.value] as const),
  );

describe("liveView chart values", () => {
  it("is off by default: no 6080 rule, no env, no route", () => {
    const list = docs(desktop);
    expect(JSON.stringify(list)).not.toContain("6080");
    expect(JSON.stringify(list)).not.toContain("PI_LIVE_VIEW");
    expect(JSON.stringify(list)).not.toContain("PI_DESKTOP_LIVE_VIEW_LISTEN");
    expect(named(list, "NetworkPolicy", "sandbox-allow-orchestrator-liveview-ingress")).toBe(
      undefined,
    );
    expect(list.filter((d) => d.kind === "HTTPRoute")).toEqual([]);
  }, 60_000);

  it("opens 6080 on desktop pods from the orchestrator only", () => {
    const list = docs(live);
    const policy = named(list, "NetworkPolicy", "sandbox-allow-orchestrator-liveview-ingress");
    expect(policy?.spec.podSelector.matchLabels).toEqual({
      "app.kubernetes.io/name": "pi-sandbox",
      "cela.dev/sandbox-flavour": "desktop",
    });
    expect(policy?.spec.ingress).toHaveLength(1);
    const rule = policy?.spec.ingress[0];
    expect(rule._from).toHaveLength(1);
    expect(rule._from[0].podSelector.matchLabels).toEqual({
      "app.kubernetes.io/name": "pi-orchestrator",
    });
    expect(rule.ports.map((p: Obj) => [p.protocol, p.port])).toEqual([["TCP", 6080]]);
    const egress = named(list, "NetworkPolicy", "orchestrator-allow-egress");
    const toSandboxes = egress?.spec.egress.find(
      (rule: Obj) =>
        rule.to?.[0]?.podSelector?.matchLabels?.["app.kubernetes.io/name"] === "pi-sandbox",
    );
    expect(toSandboxes.ports.map((p: Obj) => p.port)).toEqual([8080, 9090, 6080]);
  }, 60_000);

  it("never gives ingest a path to a sandbox", () => {
    const ingest = named(docs(live), "NetworkPolicy", "ingest-allow-egress");
    expect(JSON.stringify(ingest)).not.toContain("pi-sandbox");
    expect(JSON.stringify(ingest)).not.toContain("6080");
  }, 60_000);

  it("binds websockify beyond loopback on desktop templates only", () => {
    const list = docs(live);
    const templates = list.filter((d) => d.kind === "SandboxTemplate");
    expect(templates.length).toBeGreaterThan(0);
    for (const template of templates) {
      const container = template.spec.podTemplate.spec.containers[0];
      const flavour = template.metadata.labels["cela.dev/sandbox-flavour"];
      expect(container.env).toEqual(
        flavour === "desktop"
          ? [{ name: "PI_DESKTOP_LIVE_VIEW_LISTEN", value: "0.0.0.0" }]
          : undefined,
      );
    }
  }, 60_000);

  it("tells ingest the public URL and the orchestrators the cap", () => {
    const list = docs([...live, "--set", "liveView.maxViewersPerSession=2"]);
    expect(env(named(list, "Deployment", "pi-ingest") ?? {})).toMatchObject({
      PI_LIVE_VIEW_PUBLIC_URL: "https://live.example.lan",
      PI_LIVE_VIEW_DIR: "/app/live-view",
    });
    const orchestrators = list.filter(
      (d) => d.kind === "Deployment" && d.metadata.name.startsWith("pi-orchestrator"),
    );
    expect(orchestrators.length).toBeGreaterThan(0);
    for (const deployment of orchestrators) {
      expect(env(deployment)).toMatchObject({ PI_LIVE_VIEW: "1", PI_LIVE_VIEW_MAX_VIEWERS: "2" });
    }
  }, 60_000);

  it("renders a separate route for /live/ with no total request limit", () => {
    const r = named(docs(route), "HTTPRoute", "pi-live-view");
    expect(r?.spec.hostnames).toEqual(["live.example.lan"]);
    expect(r?.spec.rules).toEqual([
      {
        matches: [{ path: { type: "PathPrefix", value: "/live/" } }],
        timeouts: { request: "0s" },
        backendRefs: [{ kind: "Service", name: "pi-ingest", port: 8080 }],
      },
    ]);
  }, 60_000);

  it("refuses what it cannot serve", () => {
    const render = (args: string[]): string => helmTemplate(chart, [...external, ...args]);
    expect(() =>
      render(["--set", "liveView.enabled=true", "--set", "liveView.publicUrl=https://x.lan"]),
    ).toThrow(/sandbox.flavours.desktop.enabled/);
    expect(() => render([...desktop, "--set", "liveView.enabled=true"])).toThrow(/publicUrl/);
    for (const url of ["ftp://x.lan", "https://x.lan/live", "x.lan"]) {
      expect(() =>
        render([
          ...desktop,
          "--set",
          "liveView.enabled=true",
          "--set",
          `liveView.publicUrl=${url}`,
        ]),
      ).toThrow(/publicUrl/);
    }
    expect(() => render([...live, "--set", "liveView.httpRoute.enabled=true"])).toThrow(
      /networkPolicy.ingest.clients/,
    );
    expect(() => render([...desktop, "--set", "liveView.httpRoute.enabled=true"])).toThrow(
      /liveView.enabled/,
    );
    expect(() => render([...live, "--set", "liveView.maxViewersPerSession=0"])).toThrow();
  }, 120_000);
});
