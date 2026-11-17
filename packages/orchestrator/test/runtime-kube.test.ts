import { beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({
  custom: { getNamespacedCustomObject: vi.fn() },
  core: { readNamespacedPod: vi.fn() },
}));
vi.mock("@kubernetes/client-node", () => ({
  CustomObjectsApi: class {
    readonly testOnly = true;
  },
  CoreV1Api: class {
    readonly testOnly = true;
  },
  KubeConfig: class {
    loadFromDefault() {}
    makeApiClient(type: { name: string }) {
      return type.name === "CustomObjectsApi" ? api.custom : api.core;
    }
  },
}));
import { configuredRuntime, observedRuntime } from "../src/kube.ts";
beforeEach(() => vi.resetAllMocks());
describe("runtime Kubernetes observations", () => {
  it("reads the template referenced by the configured pool, including a missing RuntimeClass", async () => {
    api.custom.getNamespacedCustomObject
      .mockResolvedValueOnce({ spec: { sandboxTemplateRef: { name: "edited-template" } } })
      .mockResolvedValueOnce({ spec: { podTemplate: { spec: {} } } });
    expect(await configuredRuntime("test-ns", "pool")).toBe("");
    expect(api.custom.getNamespacedCustomObject).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        namespace: "test-ns",
        plural: "sandboxtemplates",
        name: "edited-template",
      }),
    );
  }, 1000);
  it("does not treat a missing pool reference or API failure as the node default", async () => {
    api.custom.getNamespacedCustomObject.mockResolvedValueOnce({});
    await expect(configuredRuntime("ns", "pool")).rejects.toThrow("sandboxTemplateRef");
    api.custom.getNamespacedCustomObject.mockRejectedValueOnce(new Error("forbidden"));
    await expect(configuredRuntime("ns", "pool")).rejects.toThrow("forbidden");
  }, 1000);
  it("observes the resolved warm-pool Pod rather than assuming the claim name is the Pod name", async () => {
    api.custom.getNamespacedCustomObject
      .mockResolvedValueOnce({ status: { sandbox: { name: "warm-sandbox" } } })
      .mockResolvedValueOnce({
        metadata: { annotations: { "agents.x-k8s.io/pod-name": "warm-pod" } },
      });
    api.core.readNamespacedPod.mockResolvedValueOnce({ spec: { runtimeClassName: "gvisor" } });
    expect(await observedRuntime("ns", "claim")).toBe("gvisor");
    expect(api.core.readNamespacedPod).toHaveBeenCalledWith({ namespace: "ns", name: "warm-pod" });
  }, 1000);
  it("reports an absent Pod runtime as empty, and refuses an unresolved claim", async () => {
    api.custom.getNamespacedCustomObject
      .mockResolvedValueOnce({ status: { sandbox: { name: "sandbox" } } })
      .mockResolvedValueOnce({});
    api.core.readNamespacedPod.mockResolvedValueOnce({ spec: {} });
    expect(await observedRuntime("ns", "claim")).toBe("");
    api.custom.getNamespacedCustomObject.mockResolvedValueOnce({});
    await expect(observedRuntime("ns", "claim")).rejects.toThrow("no resolved Sandbox");
  }, 1000);
});
