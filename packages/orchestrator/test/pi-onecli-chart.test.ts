import { readFileSync } from "node:fs";
import { loadYaml } from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";
import { chartsDir, helmTemplate, renderDocs, type Obj } from "./support/helm.js";

// charts/pi-onecli (install slice 10, ADR 0022): the policies that keep OneCLI's management API closed, and the values the
// upstream chart is installed with. Parsed YAML has no static shape; every field read below is asserted on.
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call */

const chart = "pi-onecli";
// loadAllYaml returns Kubernetes client classes, where `from` is `_from`: plain objects read better in assertions.
const docs = (args: string[] = []): Obj[] =>
  JSON.parse(JSON.stringify(renderDocs(chart, args)).replaceAll('"_from"', '"from"')) as Obj[];
const named = (list: Obj[], name: string): Obj => {
  const found = list.find((d) => d.metadata.name === name);
  expect(found, name).toBeDefined();
  return found ?? {};
};
const peers = (policy: Obj): string[] =>
  policy.spec.ingress.flatMap((r: Obj) =>
    r.from.map(
      (f: Obj) =>
        f.podSelector.matchLabels["app.kubernetes.io/component"] ??
        f.podSelector.matchLabels["app.kubernetes.io/name"],
    ),
  );

describe("charts/pi-onecli", () => {
  const list = docs();

  it("renders only NetworkPolicies", () => {
    for (const d of list) expect(d.kind).toBe("NetworkPolicy");
  });

  it("denies everything to the OneCLI pods first, in both directions", () => {
    const deny = named(list, "onecli-default-deny");
    expect(deny.spec.policyTypes).toEqual(["Ingress", "Egress"]);
    expect(deny.spec.podSelector.matchLabels).toEqual({
      "app.kubernetes.io/name": "onecli",
      "app.kubernetes.io/instance": "onecli",
    });
    expect(deny.spec.ingress).toBeUndefined();
    expect(deny.spec.egress).toBeUndefined();
  });

  it("lets only the orchestrator, a bootstrap Pod, the dashboard and the gateway reach the management API", () => {
    const api = named(list, "onecli-api-allow-ingress");
    expect(api.spec.podSelector.matchLabels["app.kubernetes.io/component"]).toBe("api");
    expect(peers(api)).toEqual(["pi-orchestrator", "pi-onecli-bootstrap", "web", "gateway"]);
    expect(api.spec.ingress.map((r: Obj) => r.ports)).toEqual([[{ protocol: "TCP", port: 10256 }]]);
  });

  it("lets sandboxes reach the gateway port and nothing else of OneCLI", () => {
    const gateway = named(list, "onecli-gateway-allow-ingress");
    expect(peers(gateway)).toContain("pi-sandbox");
    expect(gateway.spec.ingress.map((r: Obj) => r.ports)).toEqual([
      [{ protocol: "TCP", port: 10255 }],
    ]);
    // The sandbox label appears in no other ingress policy.
    for (const p of list.filter((d) => d.spec.ingress && d !== gateway))
      expect(JSON.stringify(p.spec.ingress)).not.toContain("pi-sandbox");
  });

  it("has no ingress to the dashboard by default, and only what web.allowFrom lists otherwise", () => {
    expect(list.find((d) => d.metadata.name === "onecli-web-allow-ingress")).toBeUndefined();
    const exposed = docs([
      "--set",
      "web.allowFrom[0].namespaceSelector.matchLabels.kubernetes\\.io/metadata\\.name=ingress-nginx",
    ]);
    const web = named(exposed, "onecli-web-allow-ingress");
    expect(web.spec.ingress).toEqual([
      {
        from: [
          {
            namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "ingress-nginx" } },
          },
        ],
        ports: [{ protocol: "TCP", port: 10254 }],
      },
    ]);
  });

  it("opens egress to DNS, the database, the OneCLI pods themselves and the public internet only", () => {
    const egress = list.filter((d) => d.spec.policyTypes?.includes("Egress") && d.spec.egress);
    const text = JSON.stringify(egress.map((d) => d.spec.egress));
    expect(text).toContain("pi-postgres");
    expect(text).toContain("kube-dns");
    // No rule reaches the orchestrator, ingest or a sandbox, and none is open to every destination except the kube API job.
    expect(text).not.toMatch(/pi-orchestrator|pi-ingest|pi-sandbox/);
    const internet = named(list, "onecli-gateway-allow-internet-egress");
    expect(internet.spec.podSelector.matchLabels["app.kubernetes.io/component"]).toBe("gateway");
    expect(internet.spec.egress[0].to[0].ipBlock.except).toEqual(
      expect.arrayContaining(["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16"]),
    );
    const job = named(list, "onecli-ca-job-allow-kube-api-egress");
    expect(job.spec.podSelector.matchLabels["app.kubernetes.io/component"]).toBe(
      "gateway-ca-generate",
    );
  });

  it("follows the release name, and can drop the internet rule", () => {
    const other = docs(["--set", "release=gw", "--set", "gateway.egressInternet=false"]);
    expect(named(other, "gw-default-deny").spec.podSelector.matchLabels).toMatchObject({
      "app.kubernetes.io/instance": "gw",
    });
    expect(
      other.find((d) => d.metadata.name === "gw-gateway-allow-internet-egress"),
    ).toBeUndefined();
  });

  describe("values.schema.json rejects bad values", () => {
    const bad: [string, string[], RegExp][] = [
      ["a bad release name", ["--set", "release=Bad_Name"], /release|pattern/],
      ["an unknown key", ["--set", "bogus=1"], /bogus|additional/],
      ["a non-string label", ["--set-json", "clients.orchestrator.app=1"], /orchestrator|string/],
      ["a bad database port", ["--set", "database.port=0"], /port|minimum/],
    ];
    for (const [name, args, message] of bad) {
      it(`rejects ${name}`, () => {
        expect(() => helmTemplate(chart, args)).toThrow(message);
      });
    }
  });
});

describe("charts/pi-onecli/upstream-values.yaml", () => {
  const values = loadYaml<Obj>(readFileSync(`${chartsDir}/${chart}/upstream-values.yaml`, "utf8"));

  it("runs the upstream chart with the runner off, no database and no route of its own", () => {
    expect(values.runner).toEqual({ enabled: false });
    expect(values.database.enabled).toBe(false);
    expect(values.database.external.existingSecret).toBe("onecli-database");
    expect(values.secrets.existingSecret).toBe("onecli-secrets");
    expect(values.ingress.enabled).toBe(false);
    expect(values.httpRoute.enabled).toBe(false);
    // One replica of each, no Redis: the chart's defaults, so nothing may raise them.
    for (const component of ["api", "web", "gateway"]) expect(values[component]).toBeUndefined();
    expect(JSON.stringify(values)).not.toMatch(/REDIS|enterpriseEnabled|password/i);
  });
});
