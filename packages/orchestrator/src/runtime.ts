import { configuredRuntime } from "./kube.js";

/** Check the actual pool/template, not a duplicate env value that a manifest edit could bypass. */
export function guardRuntime(
  runtime: string,
  allow: string | undefined,
  warn: (event: string, fields: Record<string, unknown>) => void,
): void {
  if (runtime === "gvisor") return;
  if (allow !== "1") {
    throw new Error(
      `Sandbox runtime ${JSON.stringify(runtime)} is not gvisor; set PI_ALLOW_INSECURE_RUNTIME=1 to explicitly allow an insecure runtime`,
    );
  }
  warn("INSECURE-SANDBOX-RUNTIME", {
    level: "warn",
    configuredRuntime: runtime,
    message: "Sandbox runtime isolation is NOT provided by gVisor",
  });
}

export async function checkRuntime(namespace: string, warmPool: string): Promise<string> {
  const runtime = await configuredRuntime(namespace, warmPool);
  guardRuntime(runtime, process.env.PI_ALLOW_INSECURE_RUNTIME, (event, fields) =>
    console.warn(JSON.stringify({ event, ...fields })),
  );
  return runtime;
}
