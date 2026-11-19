import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadYaml } from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";

// The OneCLI egress examples (hack/onecli-policies, ADR 0043) and the hardening host list. The open default is what
// `egress.yaml` says; the strict variant and the host rules are the opt-in tools, and their lists must stay one list.
const root = resolve(import.meta.dirname, "../../..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
interface Policy {
  metadata: { name: string };
  spec: {
    egressDeny?: { toCIDRSet: { cidr: string }[] }[];
    egress: {
      toFQDNs?: { matchName?: string; matchPattern?: string }[];
      toEntities?: string[];
      toPorts?: { ports: { port: string; protocol: string }[] }[];
    }[];
  };
}
const policy = (path: string) => loadYaml<Policy>(read(path));
const denied = (p: Policy) =>
  (p.spec.egressDeny ?? []).flatMap((d) => d.toCIDRSet.map((c) => c.cidr));

describe("hack/onecli-policies", () => {
  const open = policy("hack/onecli-policies/egress.yaml");
  const strict = policy("hack/onecli-policies/egress-strict.yaml");

  it("opens TCP 443 to the world, and keeps metadata and CGNAT denied", () => {
    const world = open.spec.egress.filter((r) => r.toEntities?.includes("world"));
    expect(world).toHaveLength(1);
    expect(world[0]?.toPorts).toEqual([{ ports: [{ port: "443", protocol: "TCP" }] }]);
    expect(open.spec.egress.some((r) => r.toFQDNs !== undefined)).toBe(false);
    expect(denied(open).sort()).toEqual(["100.64.0.0/10", "169.254.0.0/16"]);
  });

  it("keeps the FQDN list and the full private deny in the strict variant", () => {
    expect(denied(strict)).toEqual(
      expect.arrayContaining([
        "10.0.0.0/8",
        "172.16.0.0/12",
        "192.168.0.0/16",
        "100.64.0.0/10",
        "169.254.0.0/16",
      ]),
    );
    expect(strict.spec.egress.some((r) => r.toEntities !== undefined)).toBe(false);
  });

  it("never applies both: one policy name, and only the open one is in the kustomization", () => {
    expect(strict.metadata.name).toBe(open.metadata.name);
    const kustomization = read("hack/onecli-policies/kustomization.yaml");
    expect(kustomization).toContain("- egress.yaml");
    expect(kustomization).not.toContain("egress-strict");
  });
});

describe("the hardening host list", () => {
  const fqdns = (): string[] =>
    policy("hack/onecli-policies/egress-strict.yaml")
      .spec.egress.flatMap((r) => r.toFQDNs ?? [])
      .map((f) => f.matchName ?? f.matchPattern ?? "");
  const script = (): string[] => {
    const body = /^hosts=\(([^)]*)\)/ms.exec(read("hack/onecli-host-rules.sh"))?.[1] ?? "";
    return body
      .split(/\s+/)
      .filter(Boolean)
      .map((h) => h.replaceAll("'", ""));
  };
  const docs = (): string[] =>
    [...read("docs/onecli-host-rules.md").matchAll(/^\| \d+ \| allow \| `([^`]+)` \|/gm)].map(
      (m) => m[1] ?? "",
    );

  it("is the same in the strict Cilium policy, the host-rules script and the docs", () => {
    expect(script().length).toBeGreaterThan(5);
    expect(new Set(fqdns())).toEqual(new Set(script()));
    expect(new Set(docs())).toEqual(new Set(script()));
  });

  it("is not a default of the bootstrap any more (ONECLI_HOSTS opts in)", () => {
    const bootstrap = read("hack/onecli-bootstrap.sh");
    expect(bootstrap).toContain("hosts=${ONECLI_HOSTS:-}");
    expect(bootstrap).not.toContain("default_hosts");
  });
});
