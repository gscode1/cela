import { describe, expect, it } from "vitest";
import { buildProbePod, PROBE_DEADLINE_SECONDS } from "../src/netprobe-pod.js";

const pod = buildProbePod({
  name: "pi-netprobe-0-abc",
  image: "registry.example/pi-orchestrator:1",
  imagePullPolicy: "IfNotPresent",
  imagePullSecrets: [{ name: "pull" }],
  runtimeClassName: "gvisor",
  shard: 0,
  plan: {
    dnsName: "kubernetes.default.svc.cluster.local",
    control: { host: "1.1.1.1", port: 443 },
    targets: [],
  },
});

// The one Pod our TypeScript builds (docs/decisions/0019-restricted-pod-security.md; pod-security.test.ts exempts this file).
describe("isolation probe Pod", () => {
  it("carries the sandbox label, so every sandbox NetworkPolicy applies to it, and the sandbox runtime class", () => {
    expect(pod.metadata?.labels?.["app.kubernetes.io/name"]).toBe("pi-sandbox");
    expect(pod.metadata?.labels?.["pi-durable-k8s/netprobe"]).toBe("0");
    expect(pod.spec?.runtimeClassName).toBe("gvisor");
  }, 1000);

  it("wears the proxied mode label: the strictest position, so one probe covers both modes", () => {
    expect(pod.metadata?.labels?.["pi-durable.dev/network-mode"]).toBe("proxied");
  }, 1000);

  it("meets the restricted Pod Security level and holds nothing but its plan", () => {
    const spec = pod.spec;
    const container = spec?.containers[0];
    expect(spec?.securityContext).toMatchObject({
      runAsNonRoot: true,
      runAsUser: 1000,
      seccompProfile: { type: "RuntimeDefault" },
    });
    expect(container?.securityContext).toMatchObject({
      allowPrivilegeEscalation: false,
      privileged: false,
      capabilities: { drop: ["ALL"] },
    });
    expect(spec?.automountServiceAccountToken).toBe(false);
    expect(spec?.volumes).toBeUndefined();
    expect(spec?.hostNetwork).toBeUndefined();
    expect(container?.env?.map((e) => e.name)).toEqual(["NETPROBE_PLAN"]);
  }, 1000);

  it("stops by itself: never restarts and has a hard deadline", () => {
    expect(pod.spec?.restartPolicy).toBe("Never");
    expect(pod.spec?.activeDeadlineSeconds).toBe(PROBE_DEADLINE_SECONDS);
  }, 1000);

  it("omits the runtime class for the node default", () => {
    const plain = buildProbePod({
      ...{
        name: "p",
        image: "i",
        imagePullPolicy: undefined,
        imagePullSecrets: [],
        runtimeClassName: "",
        shard: 0,
        plan: { dnsName: "x", control: { host: "h", port: 1 }, targets: [] },
      },
    });
    expect(plain.spec).not.toHaveProperty("runtimeClassName");
  }, 1000);
});
