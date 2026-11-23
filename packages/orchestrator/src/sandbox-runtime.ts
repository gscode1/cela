import type { SandboxRuntimes, SessionRow } from "@cela/session-core";
import { warmPoolFor } from "./warm-pool.js";

/** A session's runtime is not defined in this deployment's `sandbox.runtimes`. Never answered with the default runtime. */
export class SandboxRuntimeNotConfiguredError extends Error {
  constructor(runtime: string) {
    super(
      `sandbox-runtime-not-configured: the session's sandbox runtime "${runtime}" is not defined in this deployment ` +
        `(chart key sandbox.runtimes.${runtime}); restore it or move the session to a profile on a configured runtime. ` +
        `It is not run on the default runtime, which would silently change its isolation.`,
    );
    this.name = "SandboxRuntimeNotConfiguredError";
  }
}

/**
 * The SandboxWarmPool a session's sandbox is claimed from (size, network mode, flavour and runtime pick it, ADR 0064).
 * A session of a runtime that the deployment no longer defines fails the attach rather than fall back to the default.
 */
export function warmPoolOfSession(
  warmPool: string,
  runtimes: SandboxRuntimes,
  session: Pick<SessionRow, "sandboxSize" | "networkMode" | "sandboxFlavour" | "sandboxRuntime">,
): string {
  const runtime = session.sandboxRuntime;
  if (runtime !== null && !Object.hasOwn(runtimes, runtime)) {
    throw new SandboxRuntimeNotConfiguredError(runtime);
  }
  return warmPoolFor(
    warmPool,
    session.sandboxSize,
    session.networkMode,
    session.sandboxFlavour,
    runtime,
  );
}
