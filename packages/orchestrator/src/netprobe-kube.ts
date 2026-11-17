import { CoreV1Api, KubeConfig } from "@kubernetes/client-node";
import type { V1Pod } from "@kubernetes/client-node";
import { PROBE_LABEL, SANDBOX_NAME, SANDBOX_NAME_LABEL } from "./netprobe-pod.js";
import type { PodReport } from "./netprobe-verdict.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function core(): CoreV1Api {
  const kc = new KubeConfig();
  kc.loadFromDefault();
  return kc.makeApiClient(CoreV1Api);
}

function isNotFound(error: unknown): boolean {
  const e = error as { code?: unknown; statusCode?: unknown } | null;
  return (e?.code ?? e?.statusCode) === 404;
}

/** The orchestrator's own Pod: its image, pull secrets and IP are what the probe Pod borrows. Needs `pods get`. */
export async function readOwnPod(namespace: string, name: string): Promise<V1Pod> {
  return core().readNamespacedPod({ name, namespace });
}

/** IP of one running sandbox Pod, if there is one: the target "another sandbox's sandboxd". Needs `pods list`. */
export async function anySandboxPodIp(namespace: string): Promise<string | undefined> {
  const pods = await core().listNamespacedPod({
    namespace,
    labelSelector: `${SANDBOX_NAME_LABEL}=${SANDBOX_NAME},!${PROBE_LABEL}`,
  });
  return pods.items.find((pod) => pod.status?.phase === "Running" && pod.status.podIP)?.status
    ?.podIP;
}

/** Deletes probe Pods left by an orchestrator that died mid-probe. Needs `pods list, delete`. */
export async function deleteProbePods(namespace: string): Promise<number> {
  const api = core();
  const pods = await api.listNamespacedPod({ namespace, labelSelector: PROBE_LABEL });
  for (const pod of pods.items) {
    const name = pod.metadata?.name;
    if (name === undefined) continue;
    await api
      .deleteNamespacedPod({ name, namespace, gracePeriodSeconds: 0 })
      .catch((error: unknown) => {
        if (!isNotFound(error)) throw error;
      });
  }
  return pods.items.length;
}

/**
 * Creates the probe Pod, waits for it to finish, reads its report and always deletes it. Needs `pods create, get,
 * delete` and `pods/log get`. A Pod that failed or printed nothing resolves to undefined (inconclusive), not an error.
 */
export async function runProbePod(
  namespace: string,
  pod: V1Pod,
  timeoutMs: number,
): Promise<{ report: PodReport | undefined; failure: string }> {
  const api = core();
  const name = pod.metadata?.name;
  if (name === undefined) throw new Error("probe Pod has no name");
  await api.createNamespacedPod({ namespace, body: pod });
  try {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const phase = (await api.readNamespacedPod({ name, namespace })).status?.phase;
      if (phase === "Succeeded") break;
      if (phase === "Failed") return { report: undefined, failure: "the probe Pod failed" };
      if (Date.now() > deadline) {
        return { report: undefined, failure: "the probe Pod did not finish in time (image pull?)" };
      }
      await sleep(1_000);
    }
    const text = await api.readNamespacedPodLog({ name, namespace });
    const line = text.split("\n").find((l) => l.startsWith("NETPROBE "));
    if (line === undefined)
      return { report: undefined, failure: "the probe Pod printed no report" };
    return { report: JSON.parse(line.slice("NETPROBE ".length)) as PodReport, failure: "" };
  } finally {
    await api
      .deleteNamespacedPod({ name, namespace, gracePeriodSeconds: 0 })
      .catch((error: unknown) => {
        if (!isNotFound(error))
          console.warn(JSON.stringify({ event: "netprobe-cleanup-failed", pod: name }));
      });
  }
}
