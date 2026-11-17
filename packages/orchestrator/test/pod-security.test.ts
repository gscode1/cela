import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { loadAllYaml } from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";

// Invariant (docs/decisions/0019-restricted-pod-security.md): every Pod our manifests and scripts can create meets the
// Pod Security "restricted" profile, and the namespaces enforce it with a pinned version. No cluster is touched.
// The YAML parser is the one @kubernetes/client-node already ships, so no dependency is added.
// Parsed YAML has no static shape; every field read below is asserted on, so the unsafe-any rules add nothing here.
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument, @typescript-eslint/restrict-template-expressions */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = Record<string, any>;

const root = resolve(import.meta.dirname, "../../..");
const version = "v1.36";

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });

// Kinds that carry a pod spec. A SandboxClaim does not (its Pod is built from the SandboxTemplate); a new kind that
// does must be added here.
const podKinds =
  "Pod|Job|CronJob|Deployment|StatefulSet|DaemonSet|ReplicaSet|SandboxTemplate|Sandbox";
const kindLine = new RegExp(`^\\s*kind:\\s*"?(${podKinds})"?\\s*$`, "gm");
const countKinds = (text: string): number => text.match(kindLine)?.length ?? 0;

const files = [...walk(join(root, "deploy")), ...walk(join(root, "tests/e2e"))]
  .filter((p) => !p.includes("/onecli-policies/") && !p.endsWith(".json"))
  .map((p) => ({ path: relative(root, p), text: readFileSync(p, "utf8") }));

// The manifests of a file: the whole file for YAML and templates, every heredoc body for a shell script or .mjs file.
const heredoc = /<<-?\s*(['"]?)(\w+)\1[^\n]*\n([\s\S]*?)\n\s*\2\s*$/gm;
const bodies = (path: string, text: string): string[] =>
  /\.(ya?ml|tpl)$/.test(path) ? [text] : [...text.matchAll(heredoc)].map((m) => m[3] ?? "");

interface Doc {
  file: string;
  kind: string;
  spec: Obj;
}

const podSpecOf = (kind: string, doc: Obj): Obj | undefined => {
  switch (kind) {
    case "Pod":
      return doc.spec;
    case "CronJob":
      return doc.spec?.jobTemplate?.spec?.template?.spec;
    case "SandboxTemplate":
    case "Sandbox":
      return doc.spec?.podTemplate?.spec;
    default:
      return doc.spec?.template?.spec;
  }
};

const discovered: Doc[] = [];
const uncovered: string[] = [];
for (const { path, text } of files) {
  const found = countKinds(text);
  if (found === 0) continue;
  let parsed = 0;
  for (const body of bodies(path, text)) {
    if (countKinds(body) === 0) continue;
    for (const doc of loadAllYaml(body) as (Obj | null)[]) {
      if (!doc || typeof doc.kind !== "string" || !new RegExp(`^(${podKinds})$`).test(doc.kind))
        continue;
      const spec = podSpecOf(doc.kind, doc);
      expect(spec, `${path}: ${doc.kind} has no pod spec`).toBeDefined();
      discovered.push({ file: path, kind: doc.kind, spec: spec ?? {} });
      parsed++;
    }
  }
  // Every `kind:` line must come out as a parsed manifest, or a manifest hides where this test cannot see it.
  if (parsed !== found) uncovered.push(`${path}: ${found} pod kinds, ${parsed} parsed`);
}

const allowedVolumes = new Set([
  "configMap",
  "csi",
  "downwardAPI",
  "emptyDir",
  "ephemeral",
  "persistentVolumeClaim",
  "projected",
  "secret",
  "name",
]);

describe("every pod-producing manifest meets the restricted Pod Security profile", () => {
  it("finds the manifests we know about, and every pod kind in the tree parses", () => {
    expect(uncovered).toEqual([]);
    const byFile = new Set(discovered.map((d) => d.file));
    for (const known of [
      "deploy/sandbox-template.yaml",
      "deploy/orchestrator.yaml",
      "deploy/ingest.yaml",
      "tests/e2e/runner-pod.yaml",
      "tests/e2e/job.yaml.tpl",
    ]) {
      expect(byFile.has(known), `${known} was not discovered`).toBe(true);
    }
  });

  for (const { file, kind, spec } of discovered) {
    describe(`${file} (${kind})`, () => {
      const podSc = spec.securityContext ?? {};
      const containers: Obj[] = [
        ...(spec.initContainers ?? []),
        ...(spec.containers ?? []),
        ...(spec.ephemeralContainers ?? []),
      ];

      it("has containers", () => {
        expect((spec.containers ?? []).length).toBeGreaterThan(0);
      });

      it("uses no host namespaces, no hostPath and only allowed volume types", () => {
        expect(spec.hostNetwork ?? false).toBe(false);
        expect(spec.hostPID ?? false).toBe(false);
        expect(spec.hostIPC ?? false).toBe(false);
        for (const volume of spec.volumes ?? []) {
          for (const type of Object.keys(volume)) {
            expect(allowedVolumes.has(type), `volume ${volume.name}: type ${type}`).toBe(true);
          }
        }
        expect(podSc.sysctls ?? []).toEqual([]);
      });

      for (const c of containers) {
        describe(`container ${c.name}`, () => {
          const sc = c.securityContext ?? {};
          it("runs as non-root, without privilege escalation, with all capabilities dropped", () => {
            expect(sc.runAsNonRoot ?? podSc.runAsNonRoot, "runAsNonRoot").toBe(true);
            expect(sc.runAsUser ?? podSc.runAsUser ?? 1).not.toBe(0);
            expect(sc.allowPrivilegeEscalation, "allowPrivilegeEscalation").toBe(false);
            expect(sc.privileged ?? false).toBe(false);
            expect(sc.capabilities?.drop).toEqual(["ALL"]);
            // Restricted allows adding only NET_BIND_SERVICE.
            for (const cap of sc.capabilities?.add ?? []) expect(cap).toBe("NET_BIND_SERVICE");
          });
          it("uses the RuntimeDefault or a Localhost seccomp profile", () => {
            const type = (sc.seccompProfile ?? podSc.seccompProfile)?.type;
            expect(["RuntimeDefault", "Localhost"], "seccompProfile.type").toContain(type);
          });
          it("exposes no host port", () => {
            for (const port of c.ports ?? []) expect(port.hostPort ?? 0).toBe(0);
          });
        });
      }
    });
  }
});

describe("no TypeScript code builds a pod spec", () => {
  // The orchestrator only creates SandboxClaims (the Pod comes from the SandboxTemplate), so there is no pod spec in
  // TypeScript to audit. A change that adds one has to extend this test.
  const sources = [
    "orchestrator",
    "sandbox-env",
    "session-core",
    "ingest",
    "egress-proxy",
    "vendor/agent-sandbox-client",
  ]
    .map((p) => join(root, "packages", p, "src"))
    .flatMap((dir) => {
      try {
        return walk(dir).filter((p) => p.endsWith(".ts"));
      } catch {
        return [];
      }
    });
  it("no source file defines a pod template, a Pod or a host namespace", () => {
    expect(sources.length).toBeGreaterThan(0);
    for (const path of sources) {
      const text = readFileSync(path, "utf8");
      expect(text, path).not.toMatch(
        /podTemplate|kind: "(Pod|Job|Sandbox|SandboxTemplate)"|hostNetwork|hostPID/,
      );
    }
  });
});

describe("the namespaces enforce the restricted level at a pinned version", () => {
  const levels = ["enforce", "warn", "audit"];
  const label = (text: string, key: string): string | undefined =>
    new RegExp(`^\\s*pod-security\\.kubernetes\\.io/${key}:\\s*"?([^"\\s]+)"?\\s*$`, "m").exec(
      text,
    )?.[1];

  for (const path of ["deploy/namespace.yaml", "tests/e2e/run.sh"]) {
    it(`${path} sets enforce, warn and audit to restricted, pinned to ${version}`, () => {
      const text = readFileSync(join(root, path), "utf8");
      for (const level of levels) {
        expect(label(text, level), level).toBe("restricted");
        expect(label(text, `${level}-version`), `${level}-version`).toBe(version);
      }
    });
  }

  it("deploy/namespace.yaml parses as a Namespace with the labels", () => {
    const [ns] = loadAllYaml(readFileSync(join(root, "deploy/namespace.yaml"), "utf8")) as Obj[];
    expect(ns?.kind).toBe("Namespace");
    expect(ns?.metadata.labels["pod-security.kubernetes.io/enforce"]).toBe("restricted");
  });

  it("tests/e2e/run.sh keeps the e2e label next to the Pod Security labels", () => {
    expect(readFileSync(join(root, "tests/e2e/run.sh"), "utf8")).toMatch(/pi-durable-e2e: "true"/);
  });
});
