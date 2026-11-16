import {
  CoreV1Api,
  CustomObjectsApi,
  KubeConfig,
  PatchStrategy,
  setHeaderOptions,
} from "@kubernetes/client-node";

/** HTTP status of a Kubernetes client error, whichever shape this client version uses. */
function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const e = error as { code?: unknown; statusCode?: unknown };
  const status = e.code ?? e.statusCode;
  return typeof status === "number" ? status : undefined;
}

async function ignoreNotFound(call: Promise<unknown>): Promise<boolean> {
  try {
    await call;
    return true;
  } catch (error) {
    if (statusOf(error) === 404) return false;
    throw error;
  }
}

/** Label that ties a SandboxClaim to the API session (or `control-<id>` for the test-only control sessions). */
export const SESSION_LABEL = "pi-durable-k8s/session-id";

const CLAIM_REF = {
  group: "extensions.agents.x-k8s.io",
  version: "v1beta1",
  plural: "sandboxclaims",
};

/** A `spec.env` entry of a SandboxClaim. */
export interface ClaimEnvVar {
  name: string;
  value: string;
}

function envValueOf(claim: unknown, name: string): string | undefined {
  const env = (claim as { spec?: { env?: ClaimEnvVar[] } }).spec?.env;
  return env?.find((entry) => entry.name === name)?.value;
}

function labelOf(claim: unknown): string | undefined {
  const labels = (claim as { metadata?: { labels?: Record<string, string> } }).metadata?.labels;
  return labels?.[SESSION_LABEL];
}

/**
 * Makes sure the named claim exists and belongs to this session. A missing claim is created with the session
 * label; an existing one is accepted only if its label matches: a claim with the right name but another (or no)
 * label is never adopted, so a name collision cannot hand one session another's sandbox and PVC. The SDK then
 * adopts the claim by name and waits for its Sandbox (it never sees an unlabelled foreign claim).
 *
 * `env` is the claim's `spec.env` (the per-sandbox token hash). The template's envVarsInjectionPolicy must allow
 * it. The env is baked into the Pod at creation, so an existing claim is accepted only if it carries the same
 * value: one created before per-sandbox tokens (or under another master) would otherwise fail every call with a
 * bare 401, and a name collision with a hash from another master must not be adopted.
 */
export async function ensureLabeledClaim(
  namespace: string,
  claimName: string,
  warmPool: string,
  sessionKey: string,
  env: readonly ClaimEnvVar[],
): Promise<void> {
  const kc = new KubeConfig();
  kc.loadFromDefault();
  const custom = kc.makeApiClient(CustomObjectsApi);
  const ref = { ...CLAIM_REF, namespace, name: claimName };
  let existing: unknown;
  try {
    existing = await custom.getNamespacedCustomObject(ref);
  } catch (error) {
    if (statusOf(error) !== 404) throw error;
  }
  if (existing !== undefined) {
    if (labelOf(existing) !== sessionKey) {
      throw new Error(`SandboxClaim ${claimName} exists but is not labelled for this session`);
    }
    for (const { name, value } of env) {
      if (envValueOf(existing, name) !== value) {
        throw new Error(
          `SandboxClaim ${claimName} has no matching ${name}: it predates per-sandbox tokens or the master key changed; ` +
            `delete the claim and its PVC to recreate it (docs/decisions/0001-per-sandbox-sandboxd-token.md)`,
        );
      }
    }
    return;
  }
  try {
    await custom.createNamespacedCustomObject({
      group: ref.group,
      version: ref.version,
      namespace,
      plural: ref.plural,
      body: {
        apiVersion: `${ref.group}/${ref.version}`,
        kind: "SandboxClaim",
        metadata: { name: claimName, namespace, labels: { [SESSION_LABEL]: sessionKey } },
        spec: { warmPoolRef: { name: warmPool }, env },
      },
    });
  } catch (error) {
    // Lost a race with another creator: fall back to the label check.
    if (statusOf(error) !== 409) throw error;
    await ensureLabeledClaim(namespace, claimName, warmPool, sessionKey, env);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Deletes a session's SandboxClaim, then its workspace PVC, and waits until both are gone. The claim goes
 * first: its Sandbox owns the Pod, and a PVC that a Pod still mounts only finishes deleting after the Pod.
 * Both calls ignore "not found", so this is safe to repeat. Needs `delete` on sandboxclaims and
 * persistentvolumeclaims in the namespace (and the `get` on claims the orchestrator has anyway).
 */
export async function deleteClaimAndPvc(
  namespace: string,
  claimName: string,
  sessionKey: string,
  timeoutMs = 180_000,
): Promise<void> {
  const kc = new KubeConfig();
  kc.loadFromDefault();
  const custom = kc.makeApiClient(CustomObjectsApi);
  const core = kc.makeApiClient(CoreV1Api);
  const claim = {
    group: "extensions.agents.x-k8s.io",
    version: "v1beta1",
    namespace,
    plural: "sandboxclaims",
    name: claimName,
  };
  // The Sandbox controller names the PVC after the volume claim template and the Sandbox (`workspace-<claim>`).
  const pvc = { name: `workspace-${claimName}`, namespace };

  // Never delete a claim that is not this session's (`get` is already granted for the SDK).
  try {
    const found: unknown = await custom.getNamespacedCustomObject(claim);
    if (labelOf(found) !== sessionKey) {
      throw new Error(
        `SandboxClaim ${claimName} is not labelled for this session: not deleting it`,
      );
    }
  } catch (error) {
    if (statusOf(error) !== 404) throw error;
  }
  // Only `delete` is needed: a delete that answers 404 means the object is gone. The PVC is deleted only once
  // the claim is gone, so the Sandbox controller cannot recreate it from a Sandbox that still exists.
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const claimPresent = await ignoreNotFound(custom.deleteNamespacedCustomObject(claim));
    const pvcPresent = claimPresent
      ? true
      : await ignoreNotFound(core.deleteNamespacedPersistentVolumeClaim(pvc));
    if (!claimPresent && !pvcPresent) return;
    if (Date.now() > deadline) {
      throw new Error(
        `timed out deleting ${claimName}: claim ${claimPresent ? "present" : "gone"}, pvc ${pvcPresent ? "present" : "gone"}`,
      );
    }
    await sleep(2_000);
  }
}

function clients(): { custom: CustomObjectsApi; core: CoreV1Api } {
  const kc = new KubeConfig();
  kc.loadFromDefault();
  return { custom: kc.makeApiClient(CustomObjectsApi), core: kc.makeApiClient(CoreV1Api) };
}

const SANDBOX_REF = { group: "agents.x-k8s.io", version: "v1beta1", plural: "sandboxes" };

/** A SandboxClaim as the orphan sweep sees it. `sessionLabel` is undefined for a claim we never labelled. */
export interface ClaimInfo {
  name: string;
  sessionLabel: string | undefined;
  createdAt: Date;
}

/** Every SandboxClaim in the namespace, labelled or not: the sweep must know a claim exists to leave its PVC alone. */
export async function listClaims(namespace: string): Promise<ClaimInfo[]> {
  const { custom } = clients();
  const list = (await custom.listNamespacedCustomObject({ ...CLAIM_REF, namespace })) as {
    items?: { metadata?: { name?: string; creationTimestamp?: string } }[];
  };
  return (list.items ?? []).flatMap((item) => {
    const name = item.metadata?.name;
    const created = item.metadata?.creationTimestamp;
    if (name === undefined || created === undefined) return [];
    return [{ name, sessionLabel: labelOf(item), createdAt: new Date(created) }];
  });
}

export interface PvcInfo {
  name: string;
  createdAt: Date;
}

export async function listPvcs(namespace: string): Promise<PvcInfo[]> {
  const { core } = clients();
  const list = await core.listNamespacedPersistentVolumeClaim({ namespace });
  return list.items.flatMap((item) => {
    const name = item.metadata?.name;
    const created = item.metadata?.creationTimestamp;
    return name === undefined || created === undefined
      ? []
      : [{ name, createdAt: new Date(created) }];
  });
}

/** `Suspended` keeps the PVC and the Sandbox object and deletes the Pod (agent-sandbox v1.0.11, controllers/sandbox_controller.go). */
export type OperatingMode = "Running" | "Suspended";

export interface SandboxInfo {
  name: string;
  mode: OperatingMode;
  /** The controller's `Suspended=True` condition: the Pod is really gone, not just asked to go. */
  podTerminated: boolean;
}

export async function listSandboxes(namespace: string): Promise<SandboxInfo[]> {
  const { custom } = clients();
  const list = (await custom.listNamespacedCustomObject({ ...SANDBOX_REF, namespace })) as {
    items?: {
      metadata?: { name?: string };
      spec?: { operatingMode?: string };
      status?: { conditions?: { type?: string; status?: string }[] };
    }[];
  };
  return (list.items ?? []).flatMap((item) => {
    const name = item.metadata?.name;
    if (name === undefined) return [];
    const suspended = item.status?.conditions?.find((c) => c.type === "Suspended");
    return [
      {
        name,
        mode: item.spec?.operatingMode === "Suspended" ? "Suspended" : "Running",
        podTerminated: suspended?.status === "True",
      },
    ];
  });
}

/**
 * Sets `spec.operatingMode` of the Sandbox that a claim created (same name). The claim controller only syncs the
 * Sandbox's pod metadata and labels, never the mode, so the patch sticks (verified live on c2 and in the controller
 * source). False if the Sandbox does not exist.
 */
export async function setOperatingMode(
  namespace: string,
  sandboxName: string,
  mode: OperatingMode,
): Promise<boolean> {
  const { custom } = clients();
  try {
    await custom.patchNamespacedCustomObject(
      { ...SANDBOX_REF, namespace, name: sandboxName, body: { spec: { operatingMode: mode } } },
      setHeaderOptions("Content-Type", PatchStrategy.MergePatch),
    );
    return true;
  } catch (error) {
    if (statusOf(error) === 404) return false;
    throw error;
  }
}

/**
 * Suspends a sandbox and waits until the controller reports its Pod gone (`Suspended=True`). Waiting matters: a
 * resume that lands while the Pod is still terminating would see a Ready Sandbox and connect to a dying Pod.
 */
export async function suspendSandbox(
  namespace: string,
  sandboxName: string,
  timeoutMs = 120_000,
): Promise<boolean> {
  if (!(await setOperatingMode(namespace, sandboxName, "Suspended"))) return false;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = (await listSandboxes(namespace)).find((s) => s.name === sandboxName);
    if (found === undefined || found.podTerminated) return true;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${sandboxName} to suspend`);
    await sleep(1_000);
  }
}

/**
 * Resumes a suspended sandbox before the SDK waits for it to be Ready (a Suspended Sandbox is never Ready, so the
 * wait would run into its timeout). True if it was suspended.
 */
export async function resumeIfSuspended(namespace: string, sandboxName: string): Promise<boolean> {
  const sandbox = (await listSandboxes(namespace)).find((s) => s.name === sandboxName);
  if (sandbox?.mode !== "Suspended") return false;
  await setOperatingMode(namespace, sandboxName, "Running");
  return true;
}

/**
 * Deletes the sandbox Pod (never the claim or the PVC) so the Sandbox controller creates a clean one on the same
 * PVC, and waits until the replacement is Ready. Needed after an interrupted command: `setsid` children escape
 * pi-env's process-group kill and only a Pod replacement reaps them. The delete is bound to the Pod's uid, so it
 * cannot hit a replacement that already exists. Returns false when there was no Pod.
 */
export async function recyclePod(
  namespace: string,
  podName: string,
  timeoutMs = 120_000,
): Promise<boolean> {
  const { core } = clients();
  let uid: string | undefined;
  try {
    uid = (await core.readNamespacedPod({ name: podName, namespace })).metadata?.uid;
  } catch (error) {
    if (statusOf(error) === 404) return false;
    throw error;
  }
  if (uid === undefined) return false;
  await ignoreNotFound(
    core.deleteNamespacedPod({
      name: podName,
      namespace,
      // Short grace: what runs inside is what we are getting rid of. The PVC is a network volume, so a 10 s kill
      // costs no more than a node failure would.
      gracePeriodSeconds: 10,
      body: { preconditions: { uid } },
    }),
  );
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const current = await core.readNamespacedPod({ name: podName, namespace });
      // The replacement has the same name, so the uid tells old from new. Wait for it to be Ready: the SDK's own
      // wait reads the Sandbox status, which can still say Ready for an instant after the Pod changed.
      const ready = current.status?.conditions?.some(
        (c) => c.type === "Ready" && c.status === "True",
      );
      if (current.metadata?.uid !== uid && ready === true) return true;
    } catch (error) {
      if (statusOf(error) !== 404) throw error;
    }
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for Pod ${podName} to be replaced`);
    await sleep(1_000);
  }
}
