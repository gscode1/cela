import type { V1Container, V1ObjectMeta, V1Pod, V1PodSpec } from "@kubernetes/client-node";
import { NETWORK_MODE_LABEL } from "@cela/session-core";
import { describe, expect, it } from "vitest";
import {
  PROBE_LABEL,
  PROBE_SERVICE_ACCOUNT,
  SANDBOX_NAME,
  SANDBOX_NAME_LABEL,
  buildProbePod,
} from "../src/netprobe-pod.js";
import { renderDocs, type Obj } from "./support/helm.js";

// ADR 0063: the chart's ValidatingAdmissionPolicy admits only the probe Pod from the orchestrator's ServiceAccount.
// CEL cannot run here (no cluster, no CEL engine), so two checks tie the policy to the code: the rendered expressions
// must name every constant buildProbePod uses, and `admits` below restates the conditions in TypeScript and must
// accept the Pod buildProbePod builds and reject each way of abusing `create pods`. A change to one side fails here.
// Parsed YAML has no static shape; every field read below is asserted on.
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/restrict-template-expressions */

const IMAGE = "ghcr.io/gscode1/pi-orchestrator:test";
const RUNTIME = "gvisor";
const chart = (args: string[] = []): Obj[] => renderDocs("cela", args);
const policyOf = (list: Obj[]): Obj | undefined =>
  list.find((d) => d.kind === "ValidatingAdmissionPolicy");

const probe = (): V1Pod =>
  buildProbePod({
    name: "pi-netprobe-0-abc123",
    image: IMAGE,
    imagePullPolicy: "IfNotPresent",
    imagePullSecrets: [{ name: "pull" }],
    runtimeClassName: RUNTIME,
    shard: 0,
    plan: { control: { host: "1.1.1.1", port: 443 }, targets: [] },
  });

/** The policy's validations, in TypeScript. What the API server fills in before validation (the default ServiceAccount) is in the Pod. */
function admits(pod: V1Pod, image = IMAGE, runtime = RUNTIME): boolean {
  const labels = pod.metadata?.labels ?? {};
  const spec = pod.spec;
  const c = spec?.containers[0];
  if (spec === undefined || c === undefined) return false;
  return (
    (pod.metadata?.name ?? "").startsWith("pi-netprobe-") &&
    Object.keys(labels).length === 3 &&
    labels[SANDBOX_NAME_LABEL] === SANDBOX_NAME &&
    labels[NETWORK_MODE_LABEL] === "proxied" &&
    PROBE_LABEL in labels &&
    spec.serviceAccountName === PROBE_SERVICE_ACCOUNT &&
    spec.automountServiceAccountToken === false &&
    (spec.volumes ?? []).length === 0 &&
    !spec.hostNetwork &&
    !spec.hostPID &&
    !spec.hostIPC &&
    spec.containers.length === 1 &&
    (spec.initContainers ?? []).length === 0 &&
    (spec.ephemeralContainers ?? []).length === 0 &&
    (spec.runtimeClassName ?? "") === runtime &&
    c.image === image &&
    c.command?.length === 3 &&
    c.command[0] === "node" &&
    c.command[1] === "-e" &&
    (c.envFrom ?? []).length === 0 &&
    (c.env ?? []).every((e) => e.valueFrom === undefined) &&
    (c.volumeMounts ?? []).length === 0 &&
    (c.volumeDevices ?? []).length === 0 &&
    (c.ports ?? []).length === 0 &&
    c.securityContext?.privileged === false &&
    c.securityContext.allowPrivilegeEscalation === false
  );
}

describe("probe Pod admission policy (chart)", () => {
  it("renders a policy and a binding for the namespace, naming only the orchestrator ServiceAccount", () => {
    const list = chart();
    const policy = policyOf(list);
    expect(policy?.metadata.name).toBe("pi-orchestrator-probe-pod-ns");
    expect(policy?.spec.failurePolicy).toBe("Fail");
    expect(policy?.spec.matchConstraints.resourceRules).toEqual([
      { apiGroups: [""], apiVersions: ["v1"], operations: ["CREATE"], resources: ["pods"] },
    ]);
    expect(policy?.spec.matchConditions.map((m: Obj) => m.expression)).toEqual([
      "request.userInfo.username == 'system:serviceaccount:ns:pi-orchestrator'",
    ]);
    const binding = list.find((d) => d.kind === "ValidatingAdmissionPolicyBinding");
    expect(binding?.spec.policyName).toBe(policy?.metadata.name);
    expect(binding?.spec.validationActions).toEqual(["Deny"]);
    expect(binding?.spec.matchResources.namespaceSelector.matchLabels).toEqual({
      "kubernetes.io/metadata.name": "ns",
    });
  }, 30_000);

  it("names the service account of the Role's subject, so the match condition cannot drift from the RoleBinding", () => {
    const list = chart();
    const subject = list.find(
      (d) => d.kind === "RoleBinding" && d.metadata.name === "pi-orchestrator",
    )?.subjects[0];
    const policy = policyOf(list);
    expect(policy?.spec.matchConditions[0].expression).toContain(
      `system:serviceaccount:${subject.namespace}:${subject.name}`,
    );
  }, 30_000);

  it("states every constant the probe Pod is built with, and the image and runtime class of the release", () => {
    const text = policyOf(chart())
      ?.spec.validations.map((v: Obj) => v.expression)
      .join("\n");
    for (const needle of [
      SANDBOX_NAME_LABEL,
      SANDBOX_NAME,
      NETWORK_MODE_LABEL,
      PROBE_LABEL,
      "'proxied'",
      `'${PROBE_SERVICE_ACCOUNT}'`,
      "automountServiceAccountToken == false",
      "pi-netprobe-",
      "envFrom",
      "valueFrom",
      "volumes",
      "'node'",
      JSON.stringify(IMAGE),
      JSON.stringify(RUNTIME),
    ]) {
      expect(text, needle).toContain(needle);
    }
    const noRuntime = policyOf(
      chart(["--set", "sandbox.runtimeClassName=", "--set", "security.allowInsecureRuntime=true"]),
    )
      ?.spec.validations.map((v: Obj) => v.expression)
      .join("\n");
    expect(noRuntime).toContain("!has(object.spec.runtimeClassName)");
  }, 60_000);

  it("is gone with security.probePodPolicy.enabled=false", () => {
    const list = chart(["--set", "security.probePodPolicy.enabled=false"]);
    expect(policyOf(list)).toBeUndefined();
    expect(list.some((d) => d.kind === "ValidatingAdmissionPolicyBinding")).toBe(false);
  }, 30_000);

  it("follows the image of the orchestrator", () => {
    const policy = policyOf(chart(["--set", "images.orchestrator.tag=v9"]));
    expect(policy?.spec.validations.map((v: Obj) => v.expression).join("\n")).toContain(
      "pi-orchestrator:v9",
    );
  }, 30_000);
});

describe("probe Pod against the policy", () => {
  it("admits the Pod buildProbePod builds, with and without pull secrets and a runtime class", () => {
    expect(admits(probe())).toBe(true);
    const plain = buildProbePod({
      name: "pi-netprobe-1-ff",
      image: IMAGE,
      imagePullPolicy: undefined,
      imagePullSecrets: [],
      runtimeClassName: "",
      shard: 1,
      plan: { control: { host: "1.1.1.1", port: 443 }, targets: [] },
    });
    expect(admits(plain, IMAGE, "")).toBe(true);
  }, 1000);

  const spec = (p: V1Pod): V1PodSpec => {
    if (p.spec === undefined) throw new Error("no spec");
    return p.spec;
  };
  const c0 = (p: V1Pod): V1Container => {
    const c = spec(p).containers[0];
    if (c === undefined) throw new Error("no container");
    return c;
  };
  const meta = (p: V1Pod): V1ObjectMeta => {
    if (p.metadata === undefined) throw new Error("no metadata");
    return p.metadata;
  };

  const abuses: [string, (pod: V1Pod) => void][] = [
    [
      "mounts a Secret",
      (p) => {
        spec(p).volumes = [{ name: "s", secret: { secretName: "onecli-secrets" } }];
      },
    ],
    [
      "reads a Secret into the environment",
      (p) => {
        c0(p).env = [
          { name: "K", valueFrom: { secretKeyRef: { name: "onecli-secrets", key: "k" } } },
        ];
      },
    ],
    [
      "reads a Secret through envFrom",
      (p) => {
        c0(p).envFrom = [{ secretRef: { name: "pi-postgres-auth" } }];
      },
    ],
    [
      "runs as another ServiceAccount",
      (p) => {
        spec(p).serviceAccountName = "pi-orchestrator";
      },
    ],
    [
      "mounts the ServiceAccount token",
      (p) => {
        spec(p).automountServiceAccountToken = true;
      },
    ],
    [
      "wears the label the OneCLI policy admits",
      (p) => {
        meta(p).labels = { ...meta(p).labels, "app.kubernetes.io/name": "onecli" };
      },
    ],
    [
      "adds a label",
      (p) => {
        meta(p).labels = { ...meta(p).labels, "app.kubernetes.io/instance": "pi-onecli" };
      },
    ],
    [
      "runs another image",
      (p) => {
        c0(p).image = "evil.example/x:1";
      },
    ],
    [
      "runs another command",
      (p) => {
        c0(p).command = ["sh", "-c", "id"];
      },
    ],
    [
      "adds a container",
      (p) => {
        spec(p).containers.push({ name: "b", image: IMAGE });
      },
    ],
    [
      "adds an init container",
      (p) => {
        spec(p).initContainers = [{ name: "i", image: IMAGE }];
      },
    ],
    [
      "joins the host network",
      (p) => {
        spec(p).hostNetwork = true;
      },
    ],
    [
      "runs privileged",
      (p) => {
        c0(p).securityContext = { privileged: true };
      },
    ],
    [
      "uses a name outside the probe's",
      (p) => {
        meta(p).name = "attacker";
      },
    ],
  ];
  it.each(abuses)(
    "rejects a Pod that %s",
    (_name, mutate) => {
      const pod = probe();
      mutate(pod);
      expect(admits(pod)).toBe(false);
    },
    1000,
  );
});
