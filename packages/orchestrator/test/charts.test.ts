import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  chartNames,
  chartsDir,
  helmTemplate,
  renderDocs,
  requiredValuesArgs,
  type Obj,
} from "./support/helm.js";

// Invariants of the Helm charts (docs/install-plan.md, ADR 0020): they render without a cluster, create nothing
// cluster-scoped, never hold a secret value, and reject bad values. Pod Security of the rendered pods is checked in
// pod-security.test.ts. Parsed YAML has no static shape; every field read below is asserted on.
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/restrict-template-expressions */

const clusterScoped = new Set([
  "Namespace",
  "CustomResourceDefinition",
  "ClusterRole",
  "ClusterRoleBinding",
  "PersistentVolume",
  "StorageClass",
  "PriorityClass",
  "RuntimeClass",
  "ValidatingWebhookConfiguration",
  "MutatingWebhookConfiguration",
  "APIService",
]);

describe.each(chartNames())("chart %s", (chart) => {
  const path = join(chartsDir, chart);

  it("passes helm lint --strict", () => {
    execFileSync("helm", ["lint", "--strict", path, ...requiredValuesArgs(chart)], {
      encoding: "utf8",
      timeout: 60_000,
    });
  });

  it("renders only namespaced kinds, none of them a Secret", () => {
    const docs = renderDocs(chart);
    expect(docs.length).toBeGreaterThan(0);
    for (const doc of docs) {
      expect(clusterScoped.has(doc.kind), `${doc.kind} is cluster-scoped`).toBe(false);
      expect(doc.kind, "charts only reference Secrets").not.toBe("Secret");
      // A namespaced object either has no namespace (helm applies the release namespace) or exactly it.
      expect(doc.metadata?.namespace ?? "ns").toBe("ns");
    }
    expect(helmTemplate(chart)).not.toMatch(/\b(lookup|randAlphaNum)\b/);
  });
});

describe("chart pi-postgres", () => {
  const docs = (args: string[] = []): Obj[] => renderDocs("pi-postgres", args);
  const sts = (args: string[] = []): Obj => {
    const found = docs(args).find((d) => d.kind === "StatefulSet");
    expect(found).toBeDefined();
    return found ?? {};
  };

  it("renders one StatefulSet replica, a headless and a ClusterIP Service, a ConfigMap and a NetworkPolicy", () => {
    const kinds = docs()
      .map((d) => d.kind)
      .sort();
    expect(kinds).toEqual(["ConfigMap", "NetworkPolicy", "Service", "Service", "StatefulSet"]);
    expect(sts().spec.replicas).toBe(1);
    const services = docs().filter((d) => d.kind === "Service");
    expect(services.map((s) => s.spec.clusterIP ?? "").sort()).toEqual(["", "None"]);
  });

  it("pins the image by digest", () => {
    for (const c of sts().spec.template.spec.containers) {
      expect(c.image).toMatch(/^postgres:17-bookworm@sha256:[0-9a-f]{64}$/);
    }
  });

  it("is read-only, non-root uid 999, with writable emptyDirs only where needed", () => {
    const spec = sts().spec.template.spec;
    expect(spec.securityContext.runAsUser).toBe(999);
    expect(spec.automountServiceAccountToken).toBe(false);
    for (const c of spec.containers) {
      expect(c.securityContext.readOnlyRootFilesystem, c.name).toBe(true);
    }
    const mounts = spec.containers.flatMap((c: Obj) => c.volumeMounts.map((m: Obj) => m.name));
    for (const name of mounts) {
      const volume = spec.volumes.find((v: Obj) => v.name === name);
      const pvc = sts().spec.volumeClaimTemplates.some((t: Obj) => t.metadata.name === name);
      expect(volume?.emptyDir !== undefined || volume?.configMap !== undefined || pvc, name).toBe(
        true,
      );
    }
  });

  it("has probes and resources on every container", () => {
    for (const c of sts().spec.template.spec.containers) {
      expect(c.readinessProbe, c.name).toBeDefined();
      expect(c.resources.requests, c.name).toBeDefined();
      expect(c.resources.limits, c.name).toBeDefined();
    }
    const postgres = sts().spec.template.spec.containers[0];
    expect(postgres.livenessProbe).toBeDefined();
    expect(postgres.startupProbe).toBeDefined();
  });

  it("takes every password from a Secret reference, and renders no password value", () => {
    const text = helmTemplate("pi-postgres");
    const refs = sts()
      .spec.template.spec.containers.flatMap((c: Obj) => c.env as Obj[])
      .filter((e: Obj) => /PASSWORD/.test(e.name));
    expect(refs.map((e: Obj) => e.name).sort()).toEqual([
      "ONECLI_PASSWORD",
      "PI_PASSWORD",
      "POSTGRES_PASSWORD",
    ]);
    for (const e of refs) {
      expect(e.value, e.name).toBeUndefined();
      expect(e.valueFrom.secretKeyRef.name, e.name).toBeTruthy();
    }
    // The init script reads passwords from the environment, never from a literal.
    expect(text).toContain("\\getenv pi_password PI_PASSWORD");
    expect(text).not.toMatch(/PASSWORD\s+'[^']/);
  });

  it("follows the Secret references in values", () => {
    const refs = sts([
      "--set",
      "auth.superuser.existingSecret=s-root",
      "--set",
      "auth.databases.onecli.existingSecret=s-oc",
      "--set",
      "auth.databases.onecli.passwordKey=k-oc",
    ])
      .spec.template.spec.containers.flatMap((c: Obj) => c.env as Obj[])
      .filter((e: Obj) => e.valueFrom)
      .map(
        (e: Obj) => `${e.name}=${e.valueFrom.secretKeyRef.name}/${e.valueFrom.secretKeyRef.key}`,
      );
    expect(refs).toContain("POSTGRES_PASSWORD=s-root/postgres-password");
    expect(refs).toContain("ONECLI_PASSWORD=s-oc/k-oc");
  });

  it("creates both databases with roles that are not superusers, idempotently", () => {
    const sql: string = docs().find((d) => d.kind === "ConfigMap")?.data["init.sql"];
    expect(sql).toMatch(/CREATE ROLE %I LOGIN/);
    expect(sql).toMatch(/NOSUPERUSER/);
    expect(sql).not.toMatch(/\bSUPERUSER\b(?<!NOSUPERUSER)/);
    expect(sql).toMatch(/WHERE NOT EXISTS \(SELECT FROM pg_roles/);
    expect(sql).toMatch(/WHERE NOT EXISTS \(SELECT FROM pg_database/);
    expect(sql).toMatch(/REVOKE CONNECT ON DATABASE %I FROM PUBLIC/);
    const env = sts()
      .spec.template.spec.containers.find((c: Obj) => c.name === "init")
      .env.filter((e: Obj) => e.value !== undefined)
      .map((e: Obj) => `${e.name}=${e.value}`);
    expect(env).toEqual(
      expect.arrayContaining(["PI_ROLE=pi", "PI_DB=pi", "ONECLI_ROLE=onecli", "ONECLI_DB=onecli"]),
    );
  });

  it("keeps the PVC by default and deletes it when retain is false", () => {
    expect(sts().spec.persistentVolumeClaimRetentionPolicy.whenDeleted).toBe("Retain");
    const off = sts(["--set", "persistence.retain=false"]);
    expect(off.spec.persistentVolumeClaimRetentionPolicy.whenDeleted).toBe("Delete");
  });

  it("sets size and storage class on the volume claim", () => {
    const claim = sts(["--set", "persistence.size=5Gi", "--set", "persistence.storageClass=fast"])
      .spec.volumeClaimTemplates[0].spec;
    expect(claim.resources.requests.storage).toBe("5Gi");
    expect(claim.storageClassName).toBe("fast");
    expect(sts().spec.volumeClaimTemplates[0].spec.storageClassName).toBeUndefined();
  });

  it("admits only 5432 from the configured client selectors, none of them CNPG", () => {
    const policy = docs().find((d) => d.kind === "NetworkPolicy");
    expect(policy?.spec.policyTypes).toEqual(["Ingress"]);
    expect(policy?.spec.podSelector.matchLabels["app.kubernetes.io/name"]).toBe("pi-postgres");
    // The YAML loader renames the key `from` to `_from`.
    for (const rule of policy?.spec.ingress ?? []) {
      expect(rule.ports).toEqual([{ protocol: "TCP", port: 5432 }]);
      for (const from of rule._from) {
        expect(from.namespaceSelector).toBeUndefined();
        expect(JSON.stringify(from)).not.toMatch(/cnpg/);
      }
    }
    const names = policy?.spec.ingress.map(
      (r: Obj) => r._from[0].podSelector.matchLabels["app.kubernetes.io/name"],
    );
    expect(names).toEqual(["pi-orchestrator", "pi-ingest", "onecli", "pi-egress-proxy"]);
    const custom = docs([
      "--set-json",
      'networkPolicy.clientSelectors=[{"pi-durable-e2e":"true"}]',
    ]).find((d) => d.kind === "NetworkPolicy");
    expect(custom?.spec.ingress).toHaveLength(1);
    expect(custom?.spec.ingress[0]._from[0].podSelector.matchLabels).toEqual({
      "pi-durable-e2e": "true",
    });
  });

  it("renders no NetworkPolicy when disabled", () => {
    expect(docs(["--set", "networkPolicy.enabled=false"]).map((d) => d.kind)).not.toContain(
      "NetworkPolicy",
    );
  });

  describe("TLS", () => {
    const postgres = (args: string[]): Obj =>
      sts(args).spec.template.spec.containers.find((c: Obj) => c.name === "postgres");
    const secretVolume = (args: string[]): Obj | undefined =>
      sts(args).spec.template.spec.volumes.find((v: Obj) => v.name === "tls");

    it("serves no TLS by default", () => {
      expect(postgres([]).args).toBeUndefined();
      expect(secretVolume([])).toBeUndefined();
      expect(docs().find((d) => d.kind === "ConfigMap")?.data["pg_hba.conf"]).toBeUndefined();
    });

    it("turns ssl on with the key and certificate of a Secret, read-only", () => {
      const args = ["--set", "tls.existingSecret=pg-cert"];
      expect(postgres(args).args).toEqual([
        "-c",
        "ssl=on",
        "-c",
        "ssl_cert_file=/etc/pg-tls/tls.crt",
        "-c",
        "ssl_key_file=/etc/pg-tls/tls.key",
      ]);
      expect(postgres(args).volumeMounts).toContainEqual({
        name: "tls",
        mountPath: "/etc/pg-tls",
        readOnly: true,
      });
      expect(secretVolume(args)?.secret).toMatchObject({
        secretName: "pg-cert",
        defaultMode: 0o440,
      });
      // Plain TCP stays allowed until requireTls (OneCLI's own connection may not use TLS yet).
      expect(docs(args).find((d) => d.kind === "ConfigMap")?.data["pg_hba.conf"]).toBeUndefined();
    });

    it("requireTls admits hostssl only", () => {
      const args = ["--set", "tls.existingSecret=pg-cert", "--set", "tls.requireTls=true"];
      expect(postgres(args).args).toContain("hba_file=/config/pg_hba.conf");
      const hba: string = docs(args).find((d) => d.kind === "ConfigMap")?.data["pg_hba.conf"];
      expect(hba).toMatch(/^hostssl all all all scram-sha-256$/m);
      expect(hba).toMatch(/^host all all all reject$/m);
      expect(hba).not.toMatch(/^host all all all scram/m);
    });

    it("restarts the pod when TLS changes", () => {
      const sum = (args: string[]): string =>
        sts(args).spec.template.metadata.annotations["checksum/init"];
      expect(sum(["--set", "tls.existingSecret=a"])).not.toBe(sum([]));
    });
  });

  describe("values.schema.json rejects bad values", () => {
    const bad: [string, string[]][] = [
      ["requireTls without a Secret", ["--set", "tls.requireTls=true"]],
      ["an empty certificate key", ["--set", "tls.certKey="]],
      ["an image without a digest", ["--set", "image.digest=latest"]],
      ["an unknown key", ["--set", "bogus=1"]],
      ["an empty superuser Secret", ["--set", "auth.superuser.existingSecret="]],
      ["an empty password key", ["--set", "auth.databases.pi.passwordKey="]],
      ["an unsafe database name", ["--set", "auth.databases.pi.name=a;drop"]],
      ["a non-boolean retain", ["--set", "persistence.retain=maybe"]],
      ["a bad size", ["--set", "persistence.size=lots"]],
      ["an empty client selector", ["--set-json", "networkPolicy.clientSelectors=[{}]"]],
    ];
    for (const [name, args] of bad) {
      it(`rejects ${name}`, () => {
        expect(() => helmTemplate("pi-postgres", args)).toThrow(/values|schema|validation/i);
      });
    }
  });
});
