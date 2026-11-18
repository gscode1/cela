import type { OrchestratorConfig } from "./config.js";
import { log } from "./log.js";
import { anySandboxPodIp, readOwnPod, runProbePod } from "./netprobe-kube.js";
import { buildProbePod } from "./netprobe-pod.js";
import { connectsHere, probePodName, resolveHost } from "./netprobe.js";
import type { ProbeIo } from "./netprobe.js";

/**
 * Public address used as the allowed TCP control when neither the egress proxy nor a OneCLI gateway is configured
 * (before the network cutover, sandboxes may reach the internet).
 */
const PUBLIC_CONTROL = { host: "1.1.1.1", port: 443 };
const POD_TIMEOUT_MS = 100_000;

function endpoint(url: string, fallbackPort: number): { host: string; port: number } | undefined {
  try {
    const parsed = new URL(url);
    // OneCLI disabled: the chart sets a placeholder that never resolves.
    if (parsed.hostname.endsWith(".invalid")) return undefined;
    const port = parsed.port === "" ? fallbackPort : Number(parsed.port);
    return { host: parsed.hostname, port };
  } catch {
    return undefined;
  }
}

/** The probe against the real cluster. `runtime` is the configured runtime class of the sandbox template. */
export function clusterProbeIo(
  config: OrchestratorConfig,
  runtime: string,
  env: NodeJS.ProcessEnv,
): ProbeIo {
  const podName = env.POD_NAME;
  const gateway = endpoint(config.onecli.gateway, 80);
  // With the egress proxy on, the sandbox reaches the proxy and nothing else (ADR 0038): the proxy is the allowed
  // control, and the OneCLI gateway, which sandboxes used to reach, becomes a denied target.
  const proxy =
    config.egressProxyUrl === undefined ? undefined : endpoint(config.egressProxyUrl, 3128);
  return {
    control: proxy ?? gateway ?? PUBLIC_CONTROL,
    proxyOnly: proxy !== undefined,
    reachableHere: (host, port) => connectsHere(host, port),
    targets: async () => {
      const wanted: { name: string; host: string | undefined; port: number }[] = [];
      const db = endpoint(config.databaseUrl.replace(/^postgres(ql)?:/, "http:"), 5432);
      if (db !== undefined)
        wanted.push({ name: "postgres", host: await resolveHost(db.host), port: db.port });
      // Service and Pod IP of the orchestrator: both paths, as section 6 of the install plan asks.
      wanted.push({
        name: "orchestrator-service",
        host: await resolveHost(`pi-orchestrator.${config.namespace}.svc`),
        port: config.port,
      });
      if (podName !== undefined) {
        const ip = (await readOwnPod(config.namespace, podName)).status?.podIP;
        wanted.push({ name: "orchestrator-pod", host: ip, port: config.port });
      }
      if (env.KUBERNETES_SERVICE_HOST !== undefined) {
        wanted.push({
          name: "kube-api",
          host: env.KUBERNETES_SERVICE_HOST,
          port: Number(env.KUBERNETES_SERVICE_PORT ?? 443),
        });
      }
      const onecliApi = endpoint(config.repos.onecliApi, 80);
      if (onecliApi !== undefined) {
        wanted.push({
          name: "onecli-api",
          host: await resolveHost(onecliApi.host),
          port: onecliApi.port,
        });
      }
      if (proxy !== undefined && gateway !== undefined) {
        wanted.push({
          name: "onecli-gateway",
          host: await resolveHost(gateway.host),
          port: gateway.port,
        });
      }
      const sandboxIp = await anySandboxPodIp(config.namespace).catch(() => undefined);
      if (sandboxIp !== undefined)
        wanted.push({ name: "other-sandbox", host: sandboxIp, port: 8080 });
      const missing = wanted.filter((t) => t.host === undefined).map((t) => t.name);
      if (missing.length > 0) log("netprobe-target-skipped", { targets: missing });
      return wanted.flatMap((t) =>
        t.host === undefined ? [] : [{ name: t.name, host: t.host, port: t.port }],
      );
    },
    runPod: async (plan) => {
      if (podName === undefined) {
        return {
          report: undefined,
          failure: "POD_NAME is not set, so the image of the probe Pod is unknown",
        };
      }
      const own = await readOwnPod(config.namespace, podName);
      const container = own.spec?.containers[0];
      if (container === undefined)
        return { report: undefined, failure: "the orchestrator Pod has no container" };
      const pod = buildProbePod({
        name: probePodName(config.shard),
        image: container.image ?? "",
        imagePullPolicy: container.imagePullPolicy,
        imagePullSecrets: own.spec?.imagePullSecrets ?? [],
        runtimeClassName: runtime,
        shard: config.shard,
        plan,
      });
      return runProbePod(config.namespace, pod, POD_TIMEOUT_MS);
    },
  };
}
