import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  chartsDir,
  helmTemplate,
  renderDocs,
  repoRoot,
  requiredValuesArgs,
  type Obj,
} from "./support/helm.js";

// charts/pi-durable (install slice 4, docs/install-plan.md): every mode renders, the runtime guard holds, nothing is
// cluster-scoped or a CRD or a CNPG resource, and the network-policy isolation invariants hold on the rendered output.
// Parsed YAML has no static shape; every field read below is asserted on.
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/restrict-template-expressions */

const chart = "pi-durable";
// NOTES.txt is printed by an install, not by `helm template`: render it with `helm install --dry-run=client`.
const execNotes = (args: string[]): string =>
  execFileSync(
    "helm",
    [
      "install",
      "rel",
      `${chartsDir}/${chart}`,
      "-n",
      "ns",
      "--dry-run=client",
      ...requiredValuesArgs(chart),
      ...args,
    ],
    { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] },
  );
const docs = (args: string[] = []): Obj[] => renderDocs(chart, args);
const external = [
  "--set",
  "onecli.mode=external",
  "--set",
  "onecli.external.apiUrl=http://onecli.onecli:10256",
  "--set",
  "onecli.external.gatewayUrl=http://onecli.onecli:10255",
];
const insecure = [
  "--set",
  "sandbox.runtimeClassName=runc",
  "--set",
  "security.allowInsecureRuntime=true",
];
const named = (list: Obj[], kind: string, name: string): Obj => {
  const found = list.find((d) => d.kind === kind && d.metadata.name === name);
  expect(found, `${kind}/${name}`).toBeDefined();
  return found ?? {};
};
const ofKind = (list: Obj[], kind: string): Obj[] => list.filter((d) => d.kind === kind);
const envOf = (deployment: Obj): Record<string, Obj> =>
  Object.fromEntries(
    deployment.spec.template.spec.containers[0].env.map((e: Obj) => [e.name, e] as const),
  );

const allowedKinds = new Set([
  "ConfigMap",
  "Deployment",
  "NetworkPolicy",
  "CiliumNetworkPolicy",
  "Role",
  "RoleBinding",
  "SandboxTemplate",
  "SandboxWarmPool",
  "Service",
  "ServiceAccount",
]);
const allowedGroups = new Set([
  "v1",
  "apps/v1",
  "networking.k8s.io/v1",
  "cilium.io/v2",
  "rbac.authorization.k8s.io/v1",
  "extensions.agents.x-k8s.io/v1beta1",
]);

interface Mode {
  provider: string;
  onecli: string;
  insecure: boolean;
  shards: number;
}
const modes: Mode[] = [];
for (const provider of ["cilium", "standard"])
  for (const onecli of ["external", "bundled", "disabled"])
    for (const insecureRuntime of [false, true])
      for (const shards of [1, 3])
        modes.push({ provider, onecli, insecure: insecureRuntime, shards });

const argsFor = (m: Mode): string[] => [
  "--set",
  `networkPolicy.provider=${m.provider}`,
  ...(m.onecli === "external" ? external : []),
  ...(m.onecli === "bundled" ? ["--set", "onecli.mode=bundled"] : []),
  ...(m.insecure ? insecure : []),
  "--set",
  `orchestrator.shards=${String(m.shards)}`,
];

describe.each(modes)(
  "mode $provider / onecli $onecli / insecure $insecure / shards $shards",
  (m) => {
    const list = docs(argsFor(m));

    it("renders only the expected namespaced kinds, no CRD, no CNPG resource, nothing cluster-scoped", () => {
      for (const d of list) {
        expect(allowedKinds.has(d.kind), `${d.kind} is not an expected kind`).toBe(true);
        expect(allowedGroups.has(d.apiVersion), `${d.kind} apiVersion ${d.apiVersion}`).toBe(true);
        expect(d.apiVersion).not.toMatch(/cnpg\.io|postgresql/);
        expect(d.metadata.namespace ?? "ns").toBe("ns");
      }
      expect(ofKind(list, "CiliumNetworkPolicy").length > 0).toBe(m.provider === "cilium");
    });

    it("has one Recreate Deployment of one replica per shard, and ingest", () => {
      const orchestrators = ofKind(list, "Deployment").filter((d) =>
        d.metadata.name.startsWith("pi-orchestrator"),
      );
      expect(orchestrators.map((d) => d.metadata.name).sort()).toEqual(
        Array.from({ length: m.shards }, (_, k) =>
          k === 0 ? "pi-orchestrator" : `pi-orchestrator-${String(k)}`,
        ).sort(),
      );
      for (const d of orchestrators) {
        expect(d.spec.replicas).toBe(1);
        expect(d.spec.strategy.type).toBe("Recreate");
      }
      expect(named(list, "Deployment", "pi-ingest").spec.replicas).toBe(2);
    });

    it("sets the runtime exactly as asked, and tells the orchestrator when it is insecure", () => {
      const template = named(list, "SandboxTemplate", "pi-env-template");
      expect(template.spec.podTemplate.spec.runtimeClassName).toBe(m.insecure ? "runc" : "gvisor");
      for (const d of ofKind(list, "Deployment").filter((x) => x.metadata.name !== "pi-ingest")) {
        expect(envOf(d).PI_ALLOW_INSECURE_RUNTIME?.value).toBe(m.insecure ? "1" : undefined);
      }
    });
  },
);

describe("orchestrator and ingest configuration", () => {
  const list = docs([...external, "--set", "orchestrator.shards=2"]);

  it("takes every required name from values or the downward API", () => {
    const env = envOf(named(list, "Deployment", "pi-orchestrator"));
    expect(env.PI_ORCH_NAMESPACE?.valueFrom.fieldRef.fieldPath).toBe("metadata.namespace");
    expect(env.PI_ORCH_WARMPOOL?.value).toBe("pi-env-pool");
    expect(env.PI_ONECLI_API?.value).toBe("http://onecli.onecli:10256");
    expect(env.PI_ONECLI_GATEWAY?.value).toBe("http://onecli.onecli:10255");
    expect(env.PI_ONECLI_NAME_PREFIX?.value).toBe("pi-session-");
    expect(env.PI_ORCH_SHARD?.value).toBe("0");
    expect(envOf(named(list, "Deployment", "pi-orchestrator-1")).PI_ORCH_SHARD?.value).toBe("1");
    expect(named(list, "SandboxWarmPool", "pi-env-pool").spec.sandboxTemplateRef.name).toBe(
      "pi-env-template",
    );
  });

  it("routes ingest by shard, with one Service per shard and the single-shard name for shard 0", () => {
    const env = envOf(named(list, "Deployment", "pi-ingest"));
    expect(env.PI_ORCH_SHARDS?.value).toBe("2");
    expect(env.PI_ORCH_URL?.value).toBe("http://pi-orchestrator-{shard}:8081");
    expect(
      ofKind(list, "Service")
        .map((s) => s.metadata.name)
        .sort(),
    ).toEqual(["pi-ingest", "pi-orchestrator", "pi-orchestrator-0", "pi-orchestrator-1"]);
    const instance = (name: string) =>
      named(list, "Service", name).spec.selector["app.kubernetes.io/instance"];
    expect(instance("pi-orchestrator")).toBe("pi-orchestrator");
    expect(instance("pi-orchestrator-0")).toBe("pi-orchestrator");
    expect(instance("pi-orchestrator-1")).toBe("pi-orchestrator-1");
    const single = envOf(named(docs(), "Deployment", "pi-ingest"));
    expect(single.PI_ORCH_URL?.value).toBe("http://pi-orchestrator:8081");
    expect(single.PI_ORCH_SHARDS?.value).toBe("1");
  });

  it("references Secrets by name and never holds a value", () => {
    const text = helmTemplate(chart, external);
    expect(ofKind(list, "Secret")).toEqual([]);
    const env = envOf(named(list, "Deployment", "pi-orchestrator"));
    expect(env.PI_DURABLE_DATABASE_URL?.valueFrom.secretKeyRef).toEqual({
      name: "pi-database",
      key: "uri",
    });
    expect(env.PI_SANDBOX_MASTER_KEY?.valueFrom.secretKeyRef).toEqual({
      name: "sandboxd-auth",
      key: "master",
    });
    expect(env.PI_API_TOKENS?.valueFrom.secretKeyRef).toEqual({ name: "api-auth", key: "tokens" });
    // Credentials are the orchestrator's only: ingest holds the database URI and the API tokens, nothing else.
    const ingest = envOf(named(list, "Deployment", "pi-ingest"));
    expect(Object.keys(ingest).filter((n) => /ONECLI|MASTER|GITHUB/.test(n))).toEqual([]);
    expect(text).not.toMatch(/\b(lookup|randAlphaNum|genCA)\b/);
    expect(text).not.toMatch(/pi-durable-poc|longhorn/);
  });

  it("wires the optional OneCLI and GitHub references, as optional", () => {
    const wired = docs([
      ...external,
      "--set",
      "onecli.external.agentTokenSecret=tok",
      "--set",
      "onecli.external.adminKeySecret=adm",
      "--set",
      "onecli.external.caConfigMap=ca",
      "--set",
      "github.app.existingSecret=gh",
    ]);
    const o = named(wired, "Deployment", "pi-orchestrator");
    const env = envOf(o);
    expect(env.ONECLI_AGENT_TOKEN?.valueFrom.secretKeyRef).toEqual({
      name: "tok",
      key: "agent-token",
      optional: true,
    });
    expect(env.ONECLI_API_KEY?.valueFrom.secretKeyRef.name).toBe("adm");
    const volumes = o.spec.template.spec.volumes;
    expect(volumes.map((v: Obj) => v.name)).toEqual(["onecli-ca", "github-app"]);
    expect(volumes[0].configMap).toEqual({ name: "ca", optional: true });
    expect(volumes[1].secret).toEqual({ secretName: "gh", optional: true });
    const none = envOf(named(list, "Deployment", "pi-orchestrator"));
    expect(none.ONECLI_AGENT_TOKEN).toBeUndefined();
    expect(none.ONECLI_API_KEY).toBeUndefined();
  });

  it("seeds the model settings from values and restarts the pods when they change", () => {
    const config = named(list, "ConfigMap", "pi-model-config");
    expect(config.data.PI_MODEL_PROVIDER).toBe("scripted");
    expect(config.data.PI_MODEL_ALLOWLIST).toBe("scripted/scripted-1,scripted/scripted-2");
    const changed = docs([
      ...external,
      "--set",
      "models.default.provider=openai-codex",
      "--set",
      "models.default.id=gpt-6.1-terra",
      "--set-json",
      'models.allowlist=["openai-codex/gpt-6.1-terra","scripted/scripted-1"]',
    ]);
    const sum = (l: Obj[]) =>
      named(l, "Deployment", "pi-orchestrator").spec.template.metadata.annotations[
        "checksum/model-config"
      ];
    expect(sum(changed)).not.toBe(sum(list));
    expect(named(changed, "ConfigMap", "pi-model-config").data.PI_MODEL_ALLOWLIST).toBe(
      "openai-codex/gpt-6.1-terra,scripted/scripted-1",
    );
  });

  it("applies image references from a tag, a digest or both, and the workspace storage class", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const l = docs([
      "--set",
      `images.orchestrator.digest=${digest}`,
      "--set",
      "images.orchestrator.tag=",
      "--set",
      `images.sandbox.digest=${digest}`,
      "--set",
      "sandbox.storageClass=fast",
    ]);
    expect(named(l, "Deployment", "pi-orchestrator").spec.template.spec.containers[0].image).toBe(
      `ghcr.io/gscode1/pi-orchestrator@${digest}`,
    );
    const template = named(l, "SandboxTemplate", "pi-env-template").spec;
    expect(template.podTemplate.spec.containers[0].image).toBe(
      `ghcr.io/gscode1/pi-sandbox:test@${digest}`,
    );
    expect(template.volumeClaimTemplates[0].spec.storageClassName).toBe("fast");
  });
});

describe("sandbox sizes (docs/decisions/0030-sandbox-sizes.md)", () => {
  const sandboxd = (template: Obj): Obj => template.spec.podTemplate.spec.containers[0];

  it("renders a template and a pool per size, plus the unsized pair on the default size", () => {
    const list = docs(external);
    expect(ofKind(list, "SandboxTemplate").map((d) => d.metadata.name)).toEqual([
      "pi-env-template",
      "pi-env-template-l",
      "pi-env-template-m",
      "pi-env-template-s",
      "pi-env-template-xl",
    ]);
    const l = named(list, "SandboxTemplate", "pi-env-template-l");
    expect(sandboxd(l).resources).toEqual({
      requests: { cpu: "1", memory: "2Gi" },
      limits: { cpu: "2", memory: "4Gi", "ephemeral-storage": "4Gi" },
    });
    expect(l.spec.volumeClaimTemplates[0].spec.resources.requests.storage).toBe("10Gi");
    // The unsized template is the default size, as every sandbox was before sizes.
    const unsized = named(list, "SandboxTemplate", "pi-env-template");
    expect(sandboxd(unsized).resources).toEqual(
      sandboxd(named(list, "SandboxTemplate", "pi-env-template-s")).resources,
    );
    expect(sandboxd(unsized).resources.limits).toEqual({
      cpu: "250m",
      memory: "256Mi",
      "ephemeral-storage": "1Gi",
    });
    for (const size of ["l", "m", "s", "xl"]) {
      const pool = named(list, "SandboxWarmPool", `pi-env-pool-${size}`);
      expect(pool.spec.sandboxTemplateRef.name).toBe(`pi-env-template-${size}`);
    }
    expect(named(list, "SandboxWarmPool", "pi-env-pool").spec).toEqual({
      replicas: 0,
      sandboxTemplateRef: { name: "pi-env-template" },
    });
    // Every size keeps the claim-env policy the per-sandbox token needs (ADR 0001).
    for (const template of ofKind(list, "SandboxTemplate")) {
      expect(template.spec.envVarsInjectionPolicy).toBe("Allowed");
    }
  });

  it("gives ingest the sizes and the default, and each size its own warm pool replicas", () => {
    const list = docs([
      ...external,
      "--set",
      "sandbox.defaultSize=m",
      "--set",
      "sandbox.sizes.m.warmPoolReplicas=2",
    ]);
    const env = envOf(named(list, "Deployment", "pi-ingest"));
    expect(env.PI_SANDBOX_DEFAULT_SIZE?.value).toBe("m");
    expect(Object.keys(JSON.parse(env.PI_SANDBOX_SIZES?.value) as object).sort()).toEqual([
      "l",
      "m",
      "s",
      "xl",
    ]);
    expect(named(list, "SandboxWarmPool", "pi-env-pool-m").spec.replicas).toBe(2);
    expect(named(list, "SandboxWarmPool", "pi-env-pool").spec.sandboxTemplateRef.name).toBe(
      "pi-env-template",
    );
    expect(
      sandboxd(named(list, "SandboxTemplate", "pi-env-template")).resources.limits.memory,
    ).toBe("2Gi");
  });

  it("refuses a default size that is not defined", () => {
    expect(() => helmTemplate(chart, [...external, "--set", "sandbox.defaultSize=huge"])).toThrow(
      /sandbox.defaultSize "huge" is not one of sandbox.sizes/,
    );
  });
});

describe("the runtime guard", () => {
  const refuses = (args: string[]) =>
    expect(() => helmTemplate(chart, args)).toThrow(/gvisor|runtimeClassName/);

  it("refuses any runtime but gvisor, including the node default, without allowInsecureRuntime", () => {
    refuses(["--set", "sandbox.runtimeClassName=runc"]);
    refuses(["--set", "sandbox.runtimeClassName=kata"]);
    refuses(["--set", "sandbox.runtimeClassName="]);
    refuses([
      "--set",
      "sandbox.runtimeClassName=runc",
      "--set",
      "security.allowInsecureRuntime=false",
    ]);
  });

  it("holds without the schema too (the template fails by itself)", () => {
    expect(() =>
      helmTemplate(chart, ["--set", "sandbox.runtimeClassName=runc", "--skip-schema-validation"]),
    ).toThrow(/not gvisor/);
  });

  it("accepts the node default or another class with allowInsecureRuntime", () => {
    const empty = docs([
      "--set",
      "sandbox.runtimeClassName=",
      "--set",
      "security.allowInsecureRuntime=true",
    ]);
    expect(
      named(empty, "SandboxTemplate", "pi-env-template").spec.podTemplate.spec.runtimeClassName,
    ).toBeUndefined();
    expect(
      envOf(named(empty, "Deployment", "pi-orchestrator")).PI_ALLOW_INSECURE_RUNTIME?.value,
    ).toBe("1");
    const kata = docs([
      "--set",
      "sandbox.runtimeClassName=kata",
      "--set",
      "security.allowInsecureRuntime=true",
    ]);
    expect(
      named(kata, "SandboxTemplate", "pi-env-template").spec.podTemplate.spec.runtimeClassName,
    ).toBe("kata");
  });

  it("warns in the notes when the runtime is not gvisor", () => {
    const notes = execNotes;
    expect(notes(insecure)).toMatch(/do NOT run under gVisor/);
    expect(notes([])).not.toMatch(/do NOT run under gVisor/);
    expect(notes([])).toMatch(/GET \/admin\/status/);
    expect(notes([])).toMatch(/NetworkPolicies isolate sandboxes only if/);
  });

  it("tells the installer about the isolation probe and how to run it again", () => {
    const text = execNotes([]);
    expect(text).toMatch(/isolation probe/);
    expect(text).toMatch(/enforced \| not-enforced \| inconclusive/);
    expect(text).toMatch(/-X POST .*\/admin\/status\/probe/);
  });
});

describe("isolation probe RBAC", () => {
  const rules = (args: string[] = []): Obj[] => named(docs(args), "Role", "pi-orchestrator").rules;
  const grant = (list: Obj[], resource: string): string[] =>
    list.filter((r) => r.resources.includes(resource)).flatMap((r) => r.verbs);

  it("lets the orchestrator create, list, read and delete its probe Pod and read its log, in the namespace only", () => {
    const list = rules();
    expect(grant(list, "pods").sort()).toEqual(["create", "delete", "get", "list"]);
    expect(grant(list, "pods/log")).toEqual(["get"]);
    // No wildcard, no write beyond pods: the probe needs nothing else.
    for (const rule of list) {
      expect(rule.verbs).not.toContain("*");
      expect(rule.resources).not.toContain("*");
    }
  });

  it("stays a namespaced Role with no ClusterRole", () => {
    for (const args of [[], external, insecure]) {
      expect(ofKind(docs(args), "ClusterRole")).toEqual([]);
    }
    const binding = named(docs(), "RoleBinding", "pi-orchestrator");
    expect(binding.subjects).toEqual([
      { kind: "ServiceAccount", name: "pi-orchestrator", namespace: "ns" },
    ]);
  });

  it("keeps the sandbox policies the probe Pod inherits through its label", () => {
    // The probe Pod wears app.kubernetes.io/name=pi-sandbox: it is judged by exactly these policies.
    const policies = ofKind(docs(external), "NetworkPolicy");
    const sandbox = policies.filter(
      (p) => p.spec.podSelector.matchLabels?.["app.kubernetes.io/name"] === "pi-sandbox",
    );
    expect(sandbox.map((p) => p.metadata.name)).toContain("sandbox-default-deny");
    expect(
      named(docs(external), "SandboxTemplate", "pi-env-template").spec.podTemplate.metadata.labels,
    ).toMatchObject({ "app.kubernetes.io/name": "pi-sandbox" });
  });
});

describe("network policy invariants", () => {
  const selectsSandbox = (p: Obj): boolean =>
    p.spec.podSelector.matchLabels?.["app.kubernetes.io/name"] === "pi-sandbox";
  const targetsOf = (rule: Obj): Obj[] => rule.to ?? [];
  const nameOfSelector = (t: Obj): string | undefined =>
    t.podSelector?.matchLabels?.["app.kubernetes.io/name"];

  for (const provider of ["cilium", "standard"]) {
    describe(`provider ${provider}`, () => {
      const list = docs([...external, "--set", `networkPolicy.provider=${provider}`]);
      const policies = ofKind(list, "NetworkPolicy");

      it("denies everything by default and allows DNS to CoreDNS only", () => {
        const deny = named(policies, "NetworkPolicy", "default-deny-all");
        expect(deny.spec.podSelector).toEqual({});
        expect(deny.spec.policyTypes).toEqual(["Ingress", "Egress"]);
        const dns = named(policies, "NetworkPolicy", "allow-dns-egress");
        expect(dns.spec.egress[0].to[0].podSelector.matchLabels).toEqual({ "k8s-app": "kube-dns" });
        expect(dns.spec.egress[0].ports.map((p: Obj) => p.port)).toEqual([53, 53]);
      });

      it("appends networkPolicy.sandbox.extraEgressExcept to the except list of its address family", () => {
        const internet = named(
          docs([
            ...external,
            ...insecure,
            "--set-json",
            'networkPolicy.sandbox.extraEgressExcept=["203.0.113.0/24","2001:db8::/32","64:ff9b::/96"]',
          ]),
          "NetworkPolicy",
          "sandbox-allow-internet-egress",
        );
        const [v4, v6] = internet.spec.egress[0].to.map((t: Obj) => t.ipBlock.except as string[]);
        expect(v4).toContain("10.0.0.0/8");
        expect(v4).toContain("203.0.113.0/24");
        expect(v4).not.toContain("2001:db8::/32");
        expect(v6).toContain("fc00::/7");
        expect(v6).toEqual(expect.arrayContaining(["2001:db8::/32", "64:ff9b::/96"]));
        expect(v6).not.toContain("203.0.113.0/24");
      });

      it("rejects an extraEgressExcept entry that is not a CIDR", () => {
        expect(() =>
          docs([
            ...external,
            ...insecure,
            "--set-json",
            'networkPolicy.sandbox.extraEgressExcept=["10.0.0.1"]',
          ]),
        ).toThrow();
      });

      it("lets a sandbox reach only DNS, the OneCLI gateway port and the public internet", () => {
        const egress = policies.filter(selectsSandbox).flatMap((p) => p.spec.egress ?? []);
        expect(egress.length).toBeGreaterThan(0);
        for (const rule of egress) {
          // No rule without a destination (that would be "anywhere").
          expect(rule.to?.length, "every sandbox egress rule names a destination").toBeGreaterThan(
            0,
          );
          for (const t of targetsOf(rule)) {
            if (t.ipBlock !== undefined) {
              expect(t.ipBlock.cidr).toMatch(/^(0\.0\.0\.0\/0|::\/0)$/);
              const except: string[] = t.ipBlock.except;
              // The private, CGNAT, link-local (metadata) and loopback ranges stay blocked: cluster, nodes, API.
              for (const range of [
                "10.0.0.0/8",
                "172.16.0.0/12",
                "192.168.0.0/16",
                "169.254.0.0/16",
              ])
                if (t.ipBlock.cidr === "0.0.0.0/0") expect(except).toContain(range);
              expect(except.length).toBeGreaterThan(0);
            } else {
              // The only in-cluster destination is the OneCLI gateway, on its port and not the API's.
              expect(t.namespaceSelector.matchLabels["kubernetes.io/metadata.name"]).toBe("onecli");
              expect(rule.ports).toEqual([{ protocol: "TCP", port: 10255 }]);
            }
          }
        }
        for (const p of policies.filter(selectsSandbox)) {
          expect(p.spec.policyTypes).not.toEqual([]);
        }
      });

      it("admits sandboxd (8080, 9090) from the orchestrator only", () => {
        const ingress = policies.filter(selectsSandbox).flatMap((p) => p.spec.ingress ?? []);
        expect(ingress).toHaveLength(1);
        expect(ingress[0]._from.map(nameOfSelector)).toEqual(["pi-orchestrator"]);
        expect(ingress[0].ports.map((p: Obj) => p.port)).toEqual([8080, 9090]);
        // No other policy admits traffic to sandboxes or lets anything reach them.
        const toSandboxes = policies
          .flatMap((p) => p.spec.egress ?? [])
          .flatMap(targetsOf)
          .filter((t) => nameOfSelector(t) === "pi-sandbox");
        expect(toSandboxes).toHaveLength(1); // the orchestrator's egress rule, from its own policy
      });

      it("opens the orchestrator to nothing but ingest, and ingest's clients only as configured", () => {
        const o = named(policies, "NetworkPolicy", "orchestrator-allow-ingress");
        expect(o.spec.ingress.flatMap((r: Obj) => r._from).map(nameOfSelector)).toEqual([
          "pi-ingest",
        ]);
        expect(
          policies.find((p) => p.metadata.name === "ingest-allow-clients-ingress"),
        ).toBeUndefined();
        const withClients = ofKind(
          docs([
            "--set-json",
            'networkPolicy.ingest.clients=[{"podSelector":{"matchLabels":{"app":"gw"}}}]',
          ]),
          "NetworkPolicy",
        );
        expect(
          named(withClients, "NetworkPolicy", "ingest-allow-clients-ingress").spec.ingress[0]._from,
        ).toEqual([{ podSelector: { matchLabels: { app: "gw" } } }]);
      });

      it("points the database rules at the configured selector, never at CNPG", () => {
        for (const name of ["orchestrator-allow-egress", "ingest-allow-egress"]) {
          const rule = named(policies, "NetworkPolicy", name).spec.egress[0];
          expect(rule.to).toEqual([
            { podSelector: { matchLabels: { "app.kubernetes.io/name": "pi-postgres" } } },
          ]);
          expect(rule.ports).toEqual([{ protocol: "TCP", port: 5432 }]);
        }
        expect(JSON.stringify(list)).not.toMatch(/cnpg|postgres-system/);
        const custom = ofKind(
          docs([
            "--set",
            "database.external.egress.namespace=db",
            "--set",
            "database.external.egress.port=6432",
            "--set-json",
            'database.external.egress.cidrs=["10.1.2.3/32"]',
          ]),
          "NetworkPolicy",
        );
        const rule = named(custom, "NetworkPolicy", "ingest-allow-egress").spec.egress[0];
        expect(rule.to[0].namespaceSelector.matchLabels["kubernetes.io/metadata.name"]).toBe("db");
        expect(rule.to[1]).toEqual({ ipBlock: { cidr: "10.1.2.3/32" } });
        expect(rule.ports[0].port).toBe(6432);
      });

      it("gives the orchestrator the gateway and the API of OneCLI, on the ports of the URLs", () => {
        const rule = named(policies, "NetworkPolicy", "orchestrator-allow-egress").spec.egress.find(
          (r: Obj) => r.to?.[0]?.namespaceSelector !== undefined,
        );
        expect(rule.ports.map((p: Obj) => p.port)).toEqual([10255, 10256]);
        const https = ofKind(
          docs([
            "--set",
            "onecli.mode=external",
            "--set",
            "onecli.external.apiUrl=https://api.example",
            "--set",
            "onecli.external.gatewayUrl=http://gw.example:8443",
          ]),
          "NetworkPolicy",
        );
        const sandboxRule = named(https, "NetworkPolicy", "sandbox-allow-onecli-egress").spec
          .egress[0];
        expect(sandboxRule.ports).toEqual([{ protocol: "TCP", port: 8443 }]);
      });

      it(`${provider === "standard" ? "renders" : "does not render"} an orchestrator egress rule to the API server`, () => {
        const rules = named(policies, "NetworkPolicy", "orchestrator-allow-egress").spec.egress;
        const toApi = rules.filter((r: Obj) =>
          (r.ports ?? []).some((p: Obj) => p.port === 443 || p.port === 6443),
        );
        if (provider === "cilium") {
          expect(toApi).toEqual([]);
          const cilium = named(list, "CiliumNetworkPolicy", "orchestrator-egress-kube-apiserver");
          expect(cilium.spec.egress[0].toEntities).toEqual(["kube-apiserver"]);
          return;
        }
        expect(toApi).toEqual([
          {
            ports: [
              { protocol: "TCP", port: 443 },
              { protocol: "TCP", port: 6443 },
            ],
          },
        ]);
        const pinned = named(
          ofKind(
            docs([
              "--set",
              "networkPolicy.provider=standard",
              "--set-json",
              'networkPolicy.kubeApiCidrs=["10.9.0.1/32","10.9.0.2/32"]',
            ]),
            "NetworkPolicy",
          ),
          "NetworkPolicy",
          "orchestrator-allow-egress",
        ).spec.egress.filter((r: Obj) => (r.ports ?? []).some((p: Obj) => p.port === 443));
        expect(pinned).toHaveLength(1);
        expect(pinned[0].to).toEqual([
          { ipBlock: { cidr: "10.9.0.1/32" } },
          { ipBlock: { cidr: "10.9.0.2/32" } },
        ]);
      });
    });
  }

  it("opens api.github.com to the orchestrator only with provider cilium and a GitHub App", () => {
    const fqdn = (args: string[]) =>
      docs(args).some((d) => d.metadata.name === "orchestrator-egress-github-api");
    expect(fqdn([])).toBe(false);
    expect(fqdn(["--set", "github.app.existingSecret=gh"])).toBe(true);
    expect(
      fqdn(["--set", "github.app.existingSecret=gh", "--set", "networkPolicy.provider=standard"]),
    ).toBe(false);
  });

  it("renders no sandbox-to-OneCLI rule when OneCLI is disabled", () => {
    const policies = ofKind(docs(), "NetworkPolicy");
    expect(policies.find((p) => p.metadata.name === "sandbox-allow-onecli-egress")).toBeUndefined();
    const orchestrator = named(policies, "NetworkPolicy", "orchestrator-allow-egress").spec.egress;
    expect(JSON.stringify(orchestrator)).not.toMatch(/onecli/);
  });
});

describe("bundled OneCLI (install slice 10, ADR 0022)", () => {
  const bundled = ["--set", "onecli.mode=bundled"];
  const list = docs(bundled);
  const orchestrator = named(list, "Deployment", "pi-orchestrator");
  const env = envOf(orchestrator);

  it("points the orchestrator at the release in its own namespace, with every reference required", () => {
    expect(env.PI_ONECLI_API?.value).toBe("http://onecli-api.ns.svc:10256");
    expect(env.PI_ONECLI_GATEWAY?.value).toBe("http://onecli-gateway.ns.svc:10255");
    // Only the one key of each Secret is exposed: the login password next to the admin key stays out of the pod.
    expect(env.ONECLI_AGENT_TOKEN?.valueFrom.secretKeyRef).toEqual({
      name: "pi-onecli",
      key: "agent-token",
      optional: false,
    });
    expect(env.ONECLI_API_KEY?.valueFrom.secretKeyRef).toEqual({
      name: "pi-onecli-admin",
      key: "api-key",
      optional: false,
    });
    expect(orchestrator.spec.template.spec.volumes).toEqual([
      { name: "onecli-ca", configMap: { name: "pi-onecli-ca", optional: false } },
    ]);
    expect(orchestrator.metadata.annotations["pi-durable/onecli-mode"]).toBe("bundled");
  });

  it("follows the release name and the object names in values", () => {
    const custom = docs([
      ...bundled,
      "--set",
      "onecli.bundled.release=gw",
      "--set",
      "onecli.bundled.caConfigMap=my-ca",
    ]);
    const o = named(custom, "Deployment", "pi-orchestrator");
    expect(envOf(o).PI_ONECLI_GATEWAY?.value).toBe("http://gw-gateway.ns.svc:10255");
    expect(o.spec.template.spec.volumes[0].configMap.name).toBe("my-ca");
    const rule = named(custom, "NetworkPolicy", "sandbox-allow-onecli-egress").spec.egress[0];
    expect(rule.to[0].podSelector.matchLabels).toEqual({
      "app.kubernetes.io/name": "onecli",
      "app.kubernetes.io/instance": "gw",
    });
  });

  it("admits the orchestrator to the API and gateway, and a sandbox to the gateway port only", () => {
    const policies = ofKind(list, "NetworkPolicy");
    const to = {
      namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "ns" } },
      podSelector: {
        matchLabels: {
          "app.kubernetes.io/name": "onecli",
          "app.kubernetes.io/instance": "onecli",
        },
      },
    };
    const orch = named(policies, "NetworkPolicy", "orchestrator-allow-egress").spec.egress;
    expect(orch.find((r: Obj) => r.to?.[0]?.namespaceSelector !== undefined)).toEqual({
      to: [to],
      ports: [
        { protocol: "TCP", port: 10255 },
        { protocol: "TCP", port: 10256 },
      ],
    });
    expect(named(policies, "NetworkPolicy", "sandbox-allow-onecli-egress").spec.egress).toEqual([
      { to: [to], ports: [{ protocol: "TCP", port: 10255 }] },
    ]);
  });

  it("renders no Secret, Ingress or HTTPRoute for OneCLI", () => {
    for (const d of list) expect(["Secret", "Ingress", "HTTPRoute"]).not.toContain(d.kind);
  });

  it("takes the object names from the same defaults as the bootstrap script", () => {
    const script = readFileSync(`${repoRoot}/hack/onecli-bootstrap.sh`, "utf8");
    const fallback = (variable: string): string | undefined =>
      new RegExp(`\\$\\{${variable}:-([^}]+)\\}`).exec(script)?.[1];
    expect(fallback("ONECLI_RELEASE")).toBe("onecli");
    expect(fallback("ONECLI_ADMIN_SECRET")).toBe("pi-onecli-admin");
    expect(fallback("ONECLI_AGENT_SECRET")).toBe("pi-onecli");
    expect(fallback("ONECLI_CA_CONFIGMAP")).toBe("pi-onecli-ca");
    expect(fallback("ONECLI_AGENT_ID")).toBe("pi-orchestrator");
  });
});

const tlsOn = (mode: string): string[] => [
  "--set",
  `database.tls.mode=${mode}`,
  "--set",
  "database.tls.existingSecret=pi-database-ca",
];

describe("database TLS", () => {
  const deployments = (args: string[]): Obj[] => {
    const all = docs(args);
    return [named(all, "Deployment", "pi-ingest"), named(all, "Deployment", "pi-orchestrator")];
  };
  const envOf = (d: Obj): Record<string, string | undefined> =>
    Object.fromEntries(
      d.spec.template.spec.containers[0].env.map((e: Obj) => [e.name, e.value] as const),
    );
  const volume = (d: Obj): Obj | undefined =>
    d.spec.template.spec.volumes?.find((v: Obj) => v.name === "database-tls");
  const mount = (d: Obj): Obj | undefined =>
    d.spec.template.spec.containers[0].volumeMounts?.find((m: Obj) => m.name === "database-tls");

  it("is off by default: no env, no volume, the URI keeps its own sslmode", () => {
    for (const d of deployments([])) {
      expect(Object.keys(envOf(d)).filter((n) => n.includes("DATABASE_TLS"))).toEqual([]);
      expect(volume(d)).toBeUndefined();
      expect(mount(d)).toBeUndefined();
    }
  });

  it("mounts the CA read-only and sets the env in both deployments", () => {
    for (const d of deployments(tlsOn("verify-full"))) {
      expect(envOf(d)).toMatchObject({
        PI_DURABLE_DATABASE_TLS_MODE: "verify-full",
        PI_DURABLE_DATABASE_TLS_CA_FILE: "/etc/pi-database-tls/ca.crt",
      });
      expect(envOf(d).PI_DURABLE_DATABASE_TLS_CERT_FILE).toBeUndefined();
      expect(mount(d)).toEqual({
        name: "database-tls",
        mountPath: "/etc/pi-database-tls",
        readOnly: true,
      });
      expect(volume(d)?.secret).toMatchObject({
        secretName: "pi-database-ca",
        items: [{ key: "ca.crt", path: "ca.crt" }],
      });
    }
  });

  it("projects a custom CA key and the client cert and key only when asked", () => {
    const args = [
      ...tlsOn("verify-ca"),
      "--set",
      "database.tls.caKey=root.pem",
      "--set",
      "database.tls.certKey=client.crt",
      "--set",
      "database.tls.keyKey=client.key",
    ];
    for (const d of deployments(args)) {
      expect(envOf(d)).toMatchObject({
        PI_DURABLE_DATABASE_TLS_MODE: "verify-ca",
        PI_DURABLE_DATABASE_TLS_CERT_FILE: "/etc/pi-database-tls/tls.crt",
        PI_DURABLE_DATABASE_TLS_KEY_FILE: "/etc/pi-database-tls/tls.key",
      });
      expect(volume(d)?.secret.items).toEqual([
        { key: "root.pem", path: "ca.crt" },
        { key: "client.crt", path: "tls.crt" },
        { key: "client.key", path: "tls.key" },
      ]);
    }
  });

  it("verify-full may use the system roots (empty caKey)", () => {
    for (const d of deployments([...tlsOn("verify-full"), "--set", "database.tls.caKey="])) {
      expect(envOf(d).PI_DURABLE_DATABASE_TLS_CA_FILE).toBeUndefined();
      expect(envOf(d).PI_DURABLE_DATABASE_TLS_MODE).toBe("verify-full");
      expect(volume(d)).toBeUndefined();
    }
  });
});

describe("values are validated", () => {
  const bad: [string, string[], RegExp][] = [
    ["an unknown OneCLI mode", ["--set", "onecli.mode=sidecar"], /onecli\/mode|one of/],
    [
      "a bundled OneCLI release with a bad name",
      ["--set", "onecli.mode=bundled", "--set", "onecli.bundled.release=Bad_Name"],
      /release|pattern/,
    ],
    [
      "a bundled OneCLI without a token Secret",
      ["--set", "onecli.mode=bundled", "--set", "onecli.bundled.agentTokenSecret="],
      /agentTokenSecret|pattern/,
    ],
    [
      "bundled agent-sandbox (a later slice)",
      ["--set", "agentSandbox.mode=bundled"],
      /agentSandbox|one of/,
    ],
    ["an external OneCLI without URLs", ["--set", "onecli.mode=external"], /onecli/],
    [
      "scripted-only OneCLI with a real provider",
      ["--set", "models.default.provider=openai-codex"],
      /disabled|OneCLI/,
    ],
    ["an unknown policy provider", ["--set", "networkPolicy.provider=calico"], /provider/],
    [
      "no database Secret",
      ["--set", "database.external.existingSecret="],
      /existingSecret|database/,
    ],
    [
      "no database egress selector",
      ["--set-json", "database.external.egress.podSelector={}"],
      /egress|database/,
    ],
    ["an image without a tag or a digest", ["--set", "images.ingest.tag="], /tag or a digest/],
    ["a malformed digest", ["--set", "images.ingest.digest=sha256:abc"], /digest/],
    ["zero shards", ["--set", "orchestrator.shards=0"], /shards/],
    ["an unknown key", ["--set", "bogus=1"], /bogus|additional/],
    ["a bad OneCLI name prefix", ["--set", "onecli.namePrefix=Bad_"], /namePrefix|pattern/],
    ["no admins", ["--set-json", "api.admins=[]"], /admins/],
    ["a bad CIDR", ["--set-json", 'networkPolicy.kubeApiCidrs=["nope"]'], /kubeApiCidrs|pattern/],
    ["a model without a provider", ["--set-json", 'models.allowlist=["x"]'], /allowlist|pattern/],
    ["an unknown database TLS mode", [...tlsOn("require")], /mode|require/],
    ["database TLS without a Secret", ["--set", "database.tls.mode=verify-full"], /existingSecret/],
    [
      "verify-ca without a CA key",
      [...tlsOn("verify-ca"), "--set", "database.tls.caKey="],
      /caKey|minLength|length/,
    ],
    [
      "a client cert without its key",
      [...tlsOn("verify-full"), "--set", "database.tls.certKey=c"],
      /keyKey/,
    ],
    [
      "a client key without its cert",
      [...tlsOn("verify-full"), "--set", "database.tls.keyKey=k"],
      /certKey/,
    ],
  ];
  for (const [name, args, message] of bad) {
    it(`rejects ${name}`, () => {
      expect(() => helmTemplate(chart, args)).toThrow(message);
    });
  }
});

describe("console.enabled", () => {
  const ingestEnv = (args: string[]): Record<string, Obj> =>
    envOf(named(docs([...external, ...args]), "Deployment", "pi-ingest"));

  it("is off by default: ingest gets no console directory", () => {
    expect(ingestEnv([]).PI_CONSOLE_DIR).toBeUndefined();
  });

  it("points ingest at the console in the image when on", () => {
    expect(ingestEnv(["--set", "console.enabled=true"]).PI_CONSOLE_DIR?.value).toBe("/app/console");
  });

  it("tells ingest to manage the catalogs by default, and to go read-only on request", () => {
    expect(ingestEnv(["--set", "console.enabled=true"]).PI_CONSOLE_CATALOGS?.value).toBe("manage");
    expect(
      ingestEnv(["--set", "console.enabled=true", "--set", "console.catalogs=readOnly"])
        .PI_CONSOLE_CATALOGS?.value,
    ).toBe("readOnly");
    expect(ingestEnv(["--set", "console.catalogs=readOnly"]).PI_CONSOLE_CATALOGS).toBeUndefined();
  });

  it("rejects a catalogs value other than manage or readOnly", () => {
    expect(() => helmTemplate(chart, [...external, "--set", "console.catalogs=write"])).toThrow(
      /console/,
    );
  });

  it("adds no Ingress, route or Service for it", () => {
    const kinds = docs([...external, "--set", "console.enabled=true"]).map((d) => d.kind);
    expect(kinds).not.toContain("Ingress");
    expect(kinds).not.toContain("HTTPRoute");
  });

  it("rejects a value that is not a boolean", () => {
    expect(() => helmTemplate(chart, [...external, "--set", "console.enabled=yes please"])).toThrow(
      /console/,
    );
  });
});

describe("ingest.expose (kind only)", () => {
  const on = [
    "--set",
    "ingest.expose.enabled=true",
    "--set",
    "ingest.expose.sourceCidr=172.20.0.1/32",
  ];
  const list = docs(external);

  it("renders nothing for it by default and keeps the ClusterIP Service as it is", () => {
    expect(JSON.stringify(list)).not.toMatch(/nodeport|NodePort/i);
    expect(list.some((d) => d.metadata.name === "ingest-allow-expose-ingress")).toBe(false);
    expect(named(list, "Service", "pi-ingest").spec.type).toBeUndefined();
  });

  it("adds a NodePort Service with externalTrafficPolicy Local, and leaves the ClusterIP Service alone", () => {
    const withExpose = docs([...external, ...on]);
    const service = named(withExpose, "Service", "pi-ingest-nodeport");
    expect(service.spec.type).toBe("NodePort");
    expect(service.spec.externalTrafficPolicy).toBe("Local");
    expect(service.spec.selector).toEqual({ "app.kubernetes.io/name": "pi-ingest" });
    expect(service.spec.ports.map((p: Obj) => [p.port, p.nodePort])).toEqual([[8080, 30080]]);
    expect(named(withExpose, "Service", "pi-ingest")).toEqual(named(list, "Service", "pi-ingest"));
  });

  it("admits ingest on 8080 from that one /32 and from no pod or namespace", () => {
    const policy = named(
      docs([...external, ...on]),
      "NetworkPolicy",
      "ingest-allow-expose-ingress",
    );
    expect(policy.spec.podSelector.matchLabels).toEqual({ "app.kubernetes.io/name": "pi-ingest" });
    expect(JSON.parse(JSON.stringify(policy.spec.ingress).replaceAll('"_from"', '"from"'))).toEqual(
      [
        {
          from: [{ ipBlock: { cidr: "172.20.0.1/32" } }],
          ports: [{ protocol: "TCP", port: 8080 }],
        },
      ],
    );
  });

  const bad: [string, string[]][] = [
    ["a source that is not a /32", ["ingest.expose.sourceCidr=172.20.0.0/16"]],
    ["an empty source", ["ingest.expose.sourceCidr="]],
    ["an IPv6 source", ["ingest.expose.sourceCidr=fc00::1/128"]],
    ["0.0.0.0/32", ["ingest.expose.sourceCidr=0.0.0.0/32"]],
  ];
  for (const [name, sets] of bad) {
    it(`rejects ${name} when expose is on`, () => {
      const args = ["ingest.expose.enabled=true", ...sets].flatMap((s) => ["--set", s]);
      expect(() => helmTemplate(chart, [...external, ...args])).toThrow(/sourceCidr|pattern|not/);
    });
  }

  it("rejects a NodePort outside 30000-32767", () => {
    expect(() =>
      helmTemplate(chart, [...external, ...on, "--set", "ingest.expose.nodePort=8080"]),
    ).toThrow(/nodePort|minimum/);
  });
});

describe("ingest.httpRoute and ingest.ingress (ADR 0026)", () => {
  const sets = (...s: string[]): string[] => s.flatMap((x) => ["--set", x]);
  const envoy = sets(
    "networkPolicy.ingest.clients[0].namespaceSelector.matchLabels.kubernetes\\.io/metadata\\.name=envoy-gateway-system",
  );
  const route = sets(
    "ingest.httpRoute.enabled=true",
    "ingest.httpRoute.parentRefs[0].name=main",
    "ingest.httpRoute.parentRefs[0].namespace=envoy-gateway-system",
    "ingest.httpRoute.hostnames[0]=pi.example.lan",
  );
  const ingress = sets(
    "ingest.ingress.enabled=true",
    "ingest.ingress.className=nginx",
    "ingest.ingress.hosts[0]=pi.example.lan",
    "ingest.ingress.tls[0].secretName=pi-tls",
    "ingest.ingress.tls[0].hosts[0]=pi.example.lan",
  );

  it("renders neither by default", () => {
    const list = docs(external);
    expect(ofKind(list, "HTTPRoute")).toEqual([]);
    expect(ofKind(list, "Ingress")).toEqual([]);
  });

  it("routes every path of the chosen hosts to pi-ingest:8080 through the HTTPRoute", () => {
    const r = named(docs([...external, ...envoy, ...route]), "HTTPRoute", "pi-ingest");
    expect(r.apiVersion).toBe("gateway.networking.k8s.io/v1");
    expect(r.metadata.namespace ?? "ns").toBe("ns");
    expect(r.spec.parentRefs).toEqual([{ name: "main", namespace: "envoy-gateway-system" }]);
    expect(r.spec.hostnames).toEqual(["pi.example.lan"]);
    const backendRefs = [{ kind: "Service", name: "pi-ingest", port: 8080 }];
    expect(r.spec.rules).toEqual([
      {
        matches: [{ path: { type: "RegularExpression", value: "/sessions/[^/]+/stream" } }],
        timeouts: { request: "0s" },
        backendRefs,
      },
      { matches: [{ path: { type: "PathPrefix", value: "/" } }], backendRefs },
    ]);
  });

  it("gives the session stream no total limit and the other paths the configured timeout", () => {
    const r = named(
      docs([...external, ...envoy, ...route, ...sets("ingest.httpRoute.timeouts.request=30s")]),
      "HTTPRoute",
      "pi-ingest",
    );
    expect(r.spec.rules.map((rule: Obj) => rule.timeouts)).toEqual([
      { request: "0s" },
      { request: "30s" },
    ]);
    const unset = named(
      docs([...external, ...envoy, ...route, ...sets("ingest.httpRoute.timeouts.stream=")]),
      "HTTPRoute",
      "pi-ingest",
    );
    expect(unset.spec.rules[0].timeouts).toBeUndefined();
    expect(() =>
      helmTemplate(chart, [
        ...external,
        ...envoy,
        ...route,
        ...sets("ingest.httpRoute.timeouts.stream=forever"),
      ]),
    ).toThrow(/stream|pattern|anyOf/);
  });

  it("routes only the operator paths when asked", () => {
    const only = sets("ingest.httpRoute.paths={/console,/admin}");
    const r = named(docs([...external, ...envoy, ...route, ...only]), "HTTPRoute", "pi-ingest");
    // No stream rule: the paths do not reach /sessions/.
    expect(r.spec.rules).toHaveLength(1);
    expect(r.spec.rules[0].matches.map((m: Obj) => m.path.value)).toEqual(["/console", "/admin"]);
  });

  it("renders the Ingress with class, TLS and a Prefix path per host", () => {
    const i = named(docs([...external, ...envoy, ...ingress]), "Ingress", "pi-ingest");
    expect(i.apiVersion).toBe("networking.k8s.io/v1");
    expect(i.spec.ingressClassName).toBe("nginx");
    expect(i.spec.tls).toEqual([{ secretName: "pi-tls", hosts: ["pi.example.lan"] }]);
    expect(i.spec.rules).toEqual([
      {
        host: "pi.example.lan",
        http: {
          paths: [
            {
              path: "/",
              pathType: "Prefix",
              backend: { service: { name: "pi-ingest", port: { number: 8080 } } },
            },
          ],
        },
      },
    ]);
  });

  it("refuses a route while networkPolicy.ingest.clients is empty", () => {
    expect(() => helmTemplate(chart, [...external, ...route])).toThrow(
      /networkPolicy\.ingest\.clients/,
    );
    expect(() => helmTemplate(chart, [...external, ...ingress])).toThrow(
      /networkPolicy\.ingest\.clients/,
    );
  });

  it("rejects an HTTPRoute without a parent, an Ingress without a host, and a path without a slash", () => {
    expect(() =>
      helmTemplate(chart, [...external, ...envoy, ...sets("ingest.httpRoute.enabled=true")]),
    ).toThrow(/parentRefs|minItems|minimum/);
    expect(() =>
      helmTemplate(chart, [...external, ...envoy, ...sets("ingest.ingress.enabled=true")]),
    ).toThrow(/hosts|minItems|minimum/);
    expect(() =>
      helmTemplate(chart, [
        ...external,
        ...envoy,
        ...route,
        ...sets("ingest.httpRoute.paths={console}"),
      ]),
    ).toThrow(/paths|pattern/);
  });
});

describe("egressProxy (ADR 0035)", () => {
  const on = [
    "--set",
    "egressProxy.enabled=true",
    "--set",
    "egressProxy.database.existingSecret=pi-egress-database",
  ];
  const proxyPolicies = (list: Obj[]): Obj[] =>
    ofKind(list, "NetworkPolicy").filter(
      (p) => p.spec.podSelector?.matchLabels?.["app.kubernetes.io/name"] === "pi-egress-proxy",
    );

  it("renders nothing by default", () => {
    const all = docs();
    expect(JSON.stringify(all)).not.toContain("pi-egress-proxy");
  });

  it("renders two replicas, a PDB, a Service and a ServiceAccount without a token", () => {
    const all = docs(on);
    const deployment = named(all, "Deployment", "pi-egress-proxy");
    expect(deployment.spec.replicas).toBe(2);
    expect(deployment.spec.template.spec.automountServiceAccountToken).toBe(false);
    expect(deployment.spec.template.spec.containers[0].securityContext.readOnlyRootFilesystem).toBe(
      true,
    );
    expect(named(all, "PodDisruptionBudget", "pi-egress-proxy").spec.minAvailable).toBe(1);
    expect(named(all, "Service", "pi-egress-proxy").spec.ports[0].port).toBe(3128);
    expect(named(all, "ServiceAccount", "pi-egress-proxy").automountServiceAccountToken).toBe(
      false,
    );
  });

  it("references the database Secret and holds no value", () => {
    const env = envOf(named(docs(on), "Deployment", "pi-egress-proxy"));
    expect(env.EGRESS_DATABASE_URL?.valueFrom.secretKeyRef).toEqual({
      name: "pi-egress-database",
      key: "uri",
    });
    expect(env.EGRESS_STALE_AFTER?.value).toBe("2m");
    expect(env.EGRESS_PLATFORM_HOSTS?.value).toContain("pi-ingest.ns.svc");
    expect(env.EGRESS_PLATFORM_HOSTS?.value).toContain("kubernetes.default.svc");
  });

  it("tells the orchestrators where the proxy is only when it is enabled, and requires a token unless told otherwise", () => {
    const orchestrator = (list: Obj[]) =>
      envOf(
        list.find(
          (d) => d.kind === "Deployment" && d.metadata.name.startsWith("pi-orchestrator"),
        ) ?? {},
      );
    expect(orchestrator(docs()).PI_EGRESS_PROXY_URL).toBeUndefined();
    const all = docs(on);
    expect(orchestrator(all).PI_EGRESS_PROXY_URL?.value).toBe("http://pi-egress-proxy.ns.svc:3128");
    // ADR 0038: with the cutover, nothing but a sandbox with its token reaches the proxy by default.
    expect(envOf(named(all, "Deployment", "pi-egress-proxy")).EGRESS_REQUIRE_AUTH?.value).toBe(
      "true",
    );
    const lax = docs([...on, "--set", "egressProxy.requireAuth=false"]);
    expect(envOf(named(lax, "Deployment", "pi-egress-proxy")).EGRESS_REQUIRE_AUTH?.value).toBe(
      "false",
    );
  });

  it("opens the internet minus private ranges, the database and only the listed private destinations", () => {
    const list = proxyPolicies(
      docs([
        ...on,
        "--set",
        "egressProxy.privateEgress[0].cidr=10.20.0.0/16",
        "--set",
        "egressProxy.privateEgress[0].ports[0]=5432",
      ]),
    );
    const names = list.map((p) => p.metadata.name).sort();
    expect(names).toEqual([
      "egress-proxy-allow-clients-ingress",
      "egress-proxy-allow-database-egress",
      "egress-proxy-allow-internet-egress",
      "egress-proxy-allow-private-egress-0",
    ]);
    const internet = list.find((p) => p.metadata.name.endsWith("internet-egress"));
    const except = internet?.spec.egress[0].to[0].ipBlock.except;
    expect(except).toEqual(expect.arrayContaining(["10.0.0.0/8", "169.254.0.0/16", "127.0.0.0/8"]));
    expect(internet?.spec.egress[0].ports.map((p: Obj) => p.port)).toEqual([80, 443]);
    const priv = list.find((p) => p.metadata.name.endsWith("private-egress-0"));
    expect(priv?.spec.egress[0].to).toEqual([{ ipBlock: { cidr: "10.20.0.0/16" } }]);
  });

  it("refuses a missing Secret, a missing image and a private entry without ports", () => {
    const run = (args: string[]): string => {
      try {
        helmTemplate(chart, args);
        return "";
      } catch (e) {
        return String((e as { stderr?: string }).stderr ?? e);
      }
    };
    expect(run(["--set", "egressProxy.enabled=true"])).toContain("existingSecret");
    expect(run([...on, "--set", "images.egressProxy.tag="])).toContain("images.egressProxy");
    expect(run([...on, "--set", "egressProxy.privateEgress[0].cidr=10.0.0.0/8"])).toMatch(/ports/);
  });

  describe("the OneCLI route (ADR 0037)", () => {
    const onecli = [
      "--set",
      "onecli.mode=bundled",
      "--set",
      "egressProxy.binding.existingSecret=pi-egress-binding",
    ];
    const all = docs([...on, ...onecli]);
    const volumesOf = (d: Obj): Obj[] => d.spec.template.spec.volumes ?? [];
    const mountsOf = (d: Obj): Obj[] =>
      d.spec.template.spec.containers.flatMap((c: Obj) => c.volumeMounts ?? []);
    const orchestrators = (list: Obj[]) =>
      list.filter((d) => d.kind === "Deployment" && d.metadata.name.startsWith("pi-orchestrator"));

    it("chains to the OneCLI gateway only: one upstream address, one egress policy on the gateway port", () => {
      const env = envOf(named(all, "Deployment", "pi-egress-proxy"));
      expect(env.EGRESS_UPSTREAM_ADDR?.value).toBe("onecli-gateway.ns.svc:10255");
      expect(env.EGRESS_BINDING_KEY_FILE?.value).toBe("/etc/pi-egress-binding/key");
      const policy = named(all, "NetworkPolicy", "egress-proxy-allow-onecli-egress").spec;
      expect(policy.policyTypes).toEqual(["Egress"]);
      expect(policy.egress).toHaveLength(1);
      expect(policy.egress[0].ports).toEqual([{ protocol: "TCP", port: 10255 }]);
      expect(policy.egress[0].to[0].podSelector.matchLabels).toMatchObject({
        "app.kubernetes.io/name": "onecli",
      });
    });

    it("mounts the binding key into the proxy and every orchestrator, never into a sandbox, and holds no key value", () => {
      for (const d of [named(all, "Deployment", "pi-egress-proxy"), ...orchestrators(all)]) {
        expect(
          volumesOf(d).find((v) => v.name === "egress-binding")?.secret,
          d.metadata.name,
        ).toEqual({
          secretName: "pi-egress-binding",
          items: [{ key: "key", path: "key" }],
        });
        expect(mountsOf(d).find((m) => m.name === "egress-binding")).toEqual({
          name: "egress-binding",
          mountPath: "/etc/pi-egress-binding",
          readOnly: true,
        });
      }
      expect(orchestrators(all).length).toBeGreaterThan(0);
      expect(envOf(orchestrators(all)[0] ?? {}).PI_EGRESS_BINDING_KEY_FILE?.value).toBe(
        "/etc/pi-egress-binding/key",
      );
      // The sandbox side of the chart (templates, claims, pools) never mentions the key.
      const sandboxish = all.filter((d) => /sandbox/i.test(d.metadata?.name ?? ""));
      expect(sandboxish.length).toBeGreaterThan(0);
      expect(JSON.stringify(sandboxish)).not.toMatch(/egress-binding|pi-egress-binding/);
    });

    it("turns the OneCLI host-rule reconciler on only when asked, and only with the admin key (ADR 0040)", () => {
      const reconciler = (documents: ReturnType<typeof docs>) =>
        envOf(orchestrators(documents)[0] ?? {}).PI_ONECLI_HOST_RULES?.value;
      expect(reconciler(all)).toBeUndefined();
      expect(reconciler(docs([...onecli, "--set", "onecli.hostRules.reconcile=true"]))).toBe(
        "reconcile",
      );
      // OneCLI disabled: no admin key to reconcile with, so the variable is not set whatever the value says.
      expect(reconciler(docs(["--set", "onecli.hostRules.reconcile=true"]))).toBeUndefined();
    });

    it("renders no upstream, key or OneCLI policy without OneCLI or without the proxy", () => {
      const noOnecli = docs(on);
      expect(envOf(named(noOnecli, "Deployment", "pi-egress-proxy")).EGRESS_UPSTREAM_ADDR).toBe(
        undefined,
      );
      expect(JSON.stringify(noOnecli)).not.toMatch(/egress-binding|BINDING_KEY/);
      expect(
        proxyPolicies(noOnecli).some((p) => p.metadata.name === "egress-proxy-allow-onecli-egress"),
      ).toBe(false);
      expect(JSON.stringify(docs(onecli))).not.toMatch(/egress-binding|EGRESS_UPSTREAM/);
    });

    it("refuses the proxy with OneCLI and no binding Secret", () => {
      let error = "";
      try {
        helmTemplate(chart, [...on, "--set", "onecli.mode=bundled"]);
      } catch (e) {
        error = String((e as { stderr?: string }).stderr ?? e);
      }
      expect(error).toContain("egressProxy.binding.existingSecret");
    });
  });
});

describe("network cutover and network modes (ADR 0038)", () => {
  const on = [
    "--set",
    "egressProxy.enabled=true",
    "--set",
    "egressProxy.database.existingSecret=pi-egress-database",
    "--set",
    "egressProxy.binding.existingSecret=pi-egress-binding",
  ];
  const gate = ["--set", "security.allowDirectSandboxEgress=true"];
  const selectsSandbox = (p: Obj): boolean =>
    p.spec.podSelector?.matchLabels?.["app.kubernetes.io/name"] === "pi-sandbox";
  const sandboxPolicies = (list: Obj[]): Obj[] =>
    ofKind(list, "NetworkPolicy").filter(selectsSandbox);
  const names = (list: Obj[]): string[] => list.map((p) => p.metadata.name).sort();
  const excludesSandboxes = (selector: Obj): boolean =>
    JSON.stringify(selector.matchExpressions) ===
    JSON.stringify([{ key: "app.kubernetes.io/name", operator: "NotIn", values: ["pi-sandbox"] }]);
  const modeOf = (t: Obj): string =>
    t.spec.podTemplate.metadata.labels["pi-durable.dev/network-mode"];

  describe("without the egress proxy (the cutover is off)", () => {
    const list = docs([...external]);

    it("keeps the sandbox policies as before: DNS, the OneCLI gateway and the internet", () => {
      expect(names(sandboxPolicies(list))).toEqual([
        "sandbox-allow-internet-egress",
        "sandbox-allow-onecli-egress",
        "sandbox-allow-orchestrator-ingress",
        "sandbox-default-deny",
      ]);
      expect(named(list, "NetworkPolicy", "allow-dns-egress").spec.podSelector).toEqual({});
      expect(
        named(list, "CiliumNetworkPolicy", "dns-egress-kube-dns-only").spec.endpointSelector,
      ).toEqual({});
    });

    it("renders only proxied templates and pools, and no direct object", () => {
      for (const t of ofKind(list, "SandboxTemplate")) expect(modeOf(t)).toBe("proxied");
      expect(JSON.stringify(list)).not.toContain("direct");
    });

    it("refuses the gate: there is no direct mode without the proxy", () => {
      expect(() => docs([...external, ...gate])).toThrow(
        /allowDirectSandboxEgress needs egressProxy/,
      );
    });
  });

  for (const provider of ["cilium", "standard"]) {
    describe(`with the egress proxy, gate off, provider ${provider}`, () => {
      const list = docs([...on, "--set", `networkPolicy.provider=${provider}`, ...external]);

      it("lets a sandbox reach the egress proxy port and nothing else", () => {
        expect(names(sandboxPolicies(list))).toEqual([
          "sandbox-allow-egress-proxy-egress",
          "sandbox-allow-orchestrator-ingress",
          "sandbox-default-deny",
        ]);
        const egress = sandboxPolicies(list).flatMap((p) => p.spec.egress ?? []);
        expect(egress).toEqual([
          {
            to: [{ podSelector: { matchLabels: { "app.kubernetes.io/name": "pi-egress-proxy" } } }],
            ports: [{ protocol: "TCP", port: 3128 }],
          },
        ]);
      });

      it("withholds the namespace-wide DNS from sandboxes, in the standard and the Cilium form", () => {
        expect(
          excludesSandboxes(named(list, "NetworkPolicy", "allow-dns-egress").spec.podSelector),
        ).toBe(true);
        if (provider === "cilium") {
          expect(
            excludesSandboxes(
              named(list, "CiliumNetworkPolicy", "dns-egress-kube-dns-only").spec.endpointSelector,
            ),
          ).toBe(true);
        }
      });

      it("renders no sandbox-to-OneCLI policy, no direct policy, template or pool", () => {
        expect(JSON.stringify(list)).not.toContain("sandbox-allow-onecli-egress");
        expect(JSON.stringify(list)).not.toContain("direct");
        for (const t of ofKind(list, "SandboxTemplate")) expect(modeOf(t)).toBe("proxied");
      });

      it("requires a token at the proxy", () => {
        expect(envOf(named(list, "Deployment", "pi-egress-proxy")).EGRESS_REQUIRE_AUTH?.value).toBe(
          "true",
        );
      });
    });

    describe(`with the egress proxy and the gate on, provider ${provider}`, () => {
      const list = docs([
        ...on,
        ...gate,
        "--set",
        `networkPolicy.provider=${provider}`,
        "--set",
        "networkPolicy.sandbox.extraEgressExcept={203.0.113.0/24,2001:db8::/32}",
        ...external,
      ]);

      it("adds DNS and the internet for the direct label only; the base policy is unchanged", () => {
        expect(names(sandboxPolicies(list))).toEqual([
          "sandbox-allow-egress-proxy-egress",
          "sandbox-allow-orchestrator-ingress",
          "sandbox-default-deny",
          "sandbox-direct-allow-egress",
        ]);
        const base = named(list, "NetworkPolicy", "sandbox-allow-egress-proxy-egress").spec;
        // The proxy policy selects every sandbox, so a Pod with a missing or unknown mode gets the proxy only.
        expect(base.podSelector).toEqual({
          matchLabels: { "app.kubernetes.io/name": "pi-sandbox" },
        });
        expect(base.egress).toHaveLength(1);
        const direct = named(list, "NetworkPolicy", "sandbox-direct-allow-egress").spec;
        expect(direct.podSelector.matchLabels).toEqual({
          "app.kubernetes.io/name": "pi-sandbox",
          "pi-durable.dev/network-mode": "direct",
        });
      });

      it("keeps every except range and extraEgressExcept in the direct policy", () => {
        const direct = named(list, "NetworkPolicy", "sandbox-direct-allow-egress").spec;
        const blocks = direct.egress.flatMap((r: Obj) => r.to).filter((t: Obj) => t.ipBlock);
        const v4 = blocks.find((t: Obj) => t.ipBlock.cidr === "0.0.0.0/0").ipBlock.except;
        const v6 = blocks.find((t: Obj) => t.ipBlock.cidr === "::/0").ipBlock.except;
        expect(v4).toEqual([
          "10.0.0.0/8",
          "172.16.0.0/12",
          "192.168.0.0/16",
          "100.64.0.0/10",
          "169.254.0.0/16",
          "127.0.0.0/8",
          "203.0.113.0/24",
        ]);
        expect(v6).toEqual(["fc00::/7", "fe80::/10", "::1/128", "2001:db8::/32"]);
      });

      it("gives a direct sandbox DNS to CoreDNS only, and no OneCLI gateway", () => {
        const direct = named(list, "NetworkPolicy", "sandbox-direct-allow-egress").spec;
        const dns = direct.egress.find((r: Obj) => r.ports?.some((p: Obj) => p.port === 53));
        expect(dns.to).toEqual([
          {
            namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } },
            podSelector: { matchLabels: { "k8s-app": "kube-dns" } },
          },
        ]);
        expect(JSON.stringify(direct)).not.toContain("onecli");
      });

      it("grants nothing beyond the proxy to a sandbox policy that does not select the direct label", () => {
        for (const p of sandboxPolicies(list)) {
          if (p.metadata.name === "sandbox-direct-allow-egress") continue;
          const to = (p.spec.egress ?? []).flatMap((r: Obj) => r.to);
          expect(
            to.every(
              (t: Obj) => t.podSelector?.matchLabels?.["app.kubernetes.io/name"] !== undefined,
            ),
            p.metadata.name,
          ).toBe(true);
          expect(JSON.stringify(to)).not.toContain("ipBlock");
        }
      });

      it("renders a direct template and a non-warm pool per size, and the unsized pair, labelled direct", () => {
        const templates = ofKind(list, "SandboxTemplate");
        const direct = templates.filter((t) => modeOf(t) === "direct").map((t) => t.metadata.name);
        expect(direct.sort()).toEqual(
          ["", "-l", "-m", "-s", "-xl"].map((suffix) => `pi-env-direct-template${suffix}`).sort(),
        );
        expect(templates.filter((t) => modeOf(t) === "proxied")).toHaveLength(5);
        for (const t of templates) {
          expect(t.metadata.labels["pi-durable.dev/network-mode"]).toBe(modeOf(t));
        }
        const pools = ofKind(list, "SandboxWarmPool").filter((p) =>
          p.metadata.name.startsWith("pi-env-direct-pool"),
        );
        expect(pools).toHaveLength(5);
        for (const p of pools) {
          expect(p.spec.replicas).toBe(0);
          expect(p.spec.sandboxTemplateRef.name).toBe(
            p.metadata.name.replace("pi-env-direct-pool", "pi-env-direct-template"),
          );
        }
      });

      it("tells ingest the gate is on, and warns in the notes", () => {
        expect(
          envOf(named(list, "Deployment", "pi-ingest")).PI_ALLOW_DIRECT_SANDBOX_EGRESS?.value,
        ).toBe("true");
        const notes = execNotes([...on, ...gate, ...external]);
        expect(notes).toMatch(/WARNING: security\.allowDirectSandboxEgress=true/);
        expect(execNotes([...on, ...external])).not.toMatch(/allowDirectSandboxEgress=true/);
      });
    });
  }

  it("tells ingest the gate is off by default", () => {
    expect(
      envOf(named(docs(), "Deployment", "pi-ingest")).PI_ALLOW_DIRECT_SANDBOX_EGRESS?.value,
    ).toBe("false");
  });

  it("says in the notes that the cutover is off without the proxy", () => {
    expect(execNotes(external)).toMatch(
      /egressProxy\.enabled=false, so the network cutover is off/,
    );
    expect(execNotes([...on, ...external])).not.toMatch(/cutover is off/);
  });
});

describe("browser flavour (ADR 0041)", () => {
  const browser = ["--set", "sandbox.flavours.browser.enabled=true"];
  const on = [
    "--set",
    "egressProxy.enabled=true",
    "--set",
    "egressProxy.database.existingSecret=pi-egress-database",
    "--set",
    "egressProxy.binding.existingSecret=pi-egress-binding",
  ];
  const gate = ["--set", "security.allowDirectSandboxEgress=true"];
  const sandboxd = (template: Obj): Obj => template.spec.podTemplate.spec.containers[0];
  const names = (list: Obj[], kind: string): string[] =>
    ofKind(list, kind).map((d) => d.metadata.name);

  it("renders no browser template or pool by default, and tells ingest so", () => {
    const list = docs(external);
    expect(names(list, "SandboxTemplate").filter((n) => n.includes("browser"))).toEqual([]);
    expect(names(list, "SandboxWarmPool").filter((n) => n.includes("browser"))).toEqual([]);
    expect(envOf(named(list, "Deployment", "pi-ingest")).PI_SANDBOX_FLAVOURS?.value).toBe("");
  });

  it("renders a browser template and pool per size, plus the unsized pair, when enabled", () => {
    const list = docs([...external, ...browser]);
    const expected = [
      "pi-env-browser-template",
      ...["l", "m", "s", "xl"].map((s) => `pi-env-browser-template-${s}`),
    ];
    expect(names(list, "SandboxTemplate").filter((n) => n.includes("browser"))).toEqual(expected);
    expect(names(list, "SandboxWarmPool").filter((n) => n.includes("browser"))).toEqual(
      expected.map((n) => n.replace("template", "pool")),
    );
    // The default flavour is unchanged.
    expect(names(list, "SandboxTemplate").filter((n) => !n.includes("browser"))).toHaveLength(5);
    expect(envOf(named(list, "Deployment", "pi-ingest")).PI_SANDBOX_FLAVOURS?.value).toBe(
      "browser",
    );
    for (const size of ["l", "m", "s", "xl"]) {
      expect(
        named(list, "SandboxWarmPool", `pi-env-browser-pool-${size}`).spec.sandboxTemplateRef.name,
      ).toBe(`pi-env-browser-template-${size}`);
    }
  });

  it("gives the browser pods their own image, resources and a memory-backed /dev/shm", () => {
    const list = docs([...external, ...browser]);
    const template = named(list, "SandboxTemplate", "pi-env-browser-template-m");
    const container = sandboxd(template);
    expect(container.image).toBe("ghcr.io/gscode1/pi-sandbox-browser:test");
    expect(container.resources).toEqual({
      requests: { cpu: "500m", memory: "768Mi" },
      limits: { cpu: "1", memory: "1536Mi", "ephemeral-storage": "2Gi" },
    });
    expect(container.volumeMounts).toContainEqual({ name: "dshm", mountPath: "/dev/shm" });
    expect(template.spec.podTemplate.spec.volumes).toEqual([
      { name: "dshm", emptyDir: { medium: "Memory", sizeLimit: "256Mi" } },
    ]);
    // The size still sets the workspace.
    expect(template.spec.volumeClaimTemplates[0].spec.resources.requests.storage).toBe("5Gi");
    // Not a browser: no /dev/shm volume, the sandbox image.
    const plain = named(list, "SandboxTemplate", "pi-env-template-m");
    expect(sandboxd(plain).image).toBe("ghcr.io/gscode1/pi-sandbox:test");
    expect(plain.spec.podTemplate.spec.volumes).toBeUndefined();
    // Same Pod security as every sandbox.
    expect(template.spec.podTemplate.spec.runtimeClassName).toBe("gvisor");
    expect(template.spec.podTemplate.spec.automountServiceAccountToken).toBe(false);
    expect(container.securityContext.capabilities).toEqual({ drop: ["ALL"] });
  });

  it("labels the Pods so the sandbox network policies still select them", () => {
    const list = docs([...external, ...browser]);
    const labels = named(list, "SandboxTemplate", "pi-env-browser-template-s").spec.podTemplate
      .metadata.labels;
    expect(labels).toMatchObject({
      "app.kubernetes.io/name": "pi-sandbox",
      "pi-durable.dev/network-mode": "proxied",
      "pi-durable.dev/sandbox-flavour": "browser",
    });
  });

  it("renders the direct twins with the gate, per flavour, size and mode", () => {
    const list = docs([...on, ...gate, ...browser, ...external]);
    const templates = names(list, "SandboxTemplate");
    expect(templates).toContain("pi-env-browser-direct-template");
    expect(templates).toContain("pi-env-browser-direct-template-xl");
    expect(templates).toHaveLength(20);
    expect(
      named(list, "SandboxTemplate", "pi-env-browser-direct-template-s").spec.podTemplate.metadata
        .labels["pi-durable.dev/network-mode"],
    ).toBe("direct");
    // Direct pools keep no warm Pods, for either flavour.
    expect(named(list, "SandboxWarmPool", "pi-env-browser-direct-pool-m").spec.replicas).toBe(0);
  });

  it("keeps warm Pods only where the operator asks, in the sized proxied browser pools", () => {
    const list = docs([
      ...external,
      ...browser,
      "--set",
      "sandbox.flavours.browser.warmPoolReplicas=1",
    ]);
    expect(named(list, "SandboxWarmPool", "pi-env-browser-pool-m").spec.replicas).toBe(1);
    expect(named(list, "SandboxWarmPool", "pi-env-browser-pool").spec.replicas).toBe(0);
    expect(named(list, "SandboxWarmPool", "pi-env-pool-m").spec.replicas).toBe(0);
  });

  it("needs the browser image once enabled", () => {
    expect(() => docs([...external, ...browser, "--set", "images.sandboxBrowser.tag="])).toThrow(
      /images\.sandboxBrowser/,
    );
  });
});
