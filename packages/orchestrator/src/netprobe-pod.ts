import type { V1Pod } from "@kubernetes/client-node";

/** Ties a probe Pod to the orchestrator that made it, for the cleanup of leftovers. */
export const PROBE_LABEL = "pi-durable-k8s/netprobe";
/** The label every NetworkPolicy for sandboxes selects (charts/pi-durable/templates/sandbox/template.yaml). */
export const SANDBOX_NAME_LABEL = "app.kubernetes.io/name";
export const SANDBOX_NAME = "pi-sandbox";
/** Hard stop in case the orchestrator dies mid-probe; its next start also deletes leftovers. */
export const PROBE_DEADLINE_SECONDS = 120;

export interface ProbePlan {
  dnsName: string;
  control: { host: string; port: number };
  targets: { name: string; host: string; port: number }[];
}

/**
 * Runs in the probe Pod with `node -e`. Targets are IP addresses (the orchestrator resolved them), so a failure is the
 * network's, never a DNS error; DNS is exercised by its own control. Prints one `NETPROBE {json}` line.
 */
export const PROBE_SCRIPT = `
const net = require("node:net");
const dns = require("node:dns/promises");
const plan = JSON.parse(process.env.NETPROBE_PLAN);
const tcp = (host, port) => new Promise((resolve) => {
  const socket = net.connect({ host, port });
  socket.setTimeout(4000);
  socket.once("connect", () => { socket.destroy(); resolve("connected"); });
  socket.once("timeout", () => { socket.destroy(); resolve("timeout"); });
  socket.once("error", (e) => resolve(e.code === "ECONNREFUSED" ? "refused" : "error"));
});
(async () => {
  const report = { dns: false, control: "error", targets: {} };
  try { await dns.lookup(plan.dnsName); report.dns = true; } catch {}
  report.control = await tcp(plan.control.host, plan.control.port);
  await Promise.all(plan.targets.map(async (t) => { report.targets[t.name] = await tcp(t.host, t.port); }));
  console.log("NETPROBE " + JSON.stringify(report));
})();
`;

export interface ProbePodInput {
  name: string;
  /** The orchestrator's own image: it has node, and is already pullable in this namespace. */
  image: string;
  imagePullPolicy: string | undefined;
  imagePullSecrets: { name?: string }[];
  /** The runtime class the sandboxes use, so the probe sees the same network path. */
  runtimeClassName: string;
  shard: number;
  plan: ProbePlan;
}

/**
 * A plain Pod with the sandbox's label, so every NetworkPolicy that selects sandboxes applies to it. It meets the
 * restricted Pod Security level (docs/decisions/0019) and has no service account token, no volume and no secret. It
 * stays out of the Sandbox controllers' sight: no claim, no PVC, no per-sandbox token.
 */
export function buildProbePod(input: ProbePodInput): V1Pod {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: input.name,
      labels: {
        [SANDBOX_NAME_LABEL]: SANDBOX_NAME,
        [PROBE_LABEL]: String(input.shard),
      },
    },
    spec: {
      restartPolicy: "Never",
      activeDeadlineSeconds: PROBE_DEADLINE_SECONDS,
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      ...(input.runtimeClassName === "" ? {} : { runtimeClassName: input.runtimeClassName }),
      ...(input.imagePullSecrets.length === 0 ? {} : { imagePullSecrets: input.imagePullSecrets }),
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 1000,
        runAsGroup: 1000,
        seccompProfile: { type: "RuntimeDefault" },
      },
      containers: [
        {
          name: "probe",
          image: input.image,
          ...(input.imagePullPolicy === undefined
            ? {}
            : { imagePullPolicy: input.imagePullPolicy }),
          command: ["node", "-e", PROBE_SCRIPT],
          env: [{ name: "NETPROBE_PLAN", value: JSON.stringify(input.plan) }],
          securityContext: {
            allowPrivilegeEscalation: false,
            privileged: false,
            readOnlyRootFilesystem: true,
            capabilities: { drop: ["ALL"] },
          },
          resources: {
            requests: { cpu: "10m", memory: "64Mi" },
            limits: { cpu: "200m", memory: "128Mi" },
          },
        },
      ],
    },
  };
}
