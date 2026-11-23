import type { ProfileDefinition } from "./profiles.js";

/**
 * Named sandbox runtimes (issue #406): a profile may pick a runtime beyond the deployment's default one (the chart's
 * `sandbox.runtimeClassName`). Chosen by the profile, fixed per session, like the network mode and the flavour.
 * `default` is what an absent `sandboxRuntime` means; it is never a named runtime.
 */
export const DEFAULT_SANDBOX_RUNTIME = "default";

/** A named runtime: also the infix of its pools (`pi-env-rt-<name>-pool`), so no hyphens. */
export const SANDBOX_RUNTIME_NAME = /^[a-z][a-z0-9]{0,15}$/;

/** Names the chart refuses because they would collide with a pool or template name part. */
export const RESERVED_SANDBOX_RUNTIME_NAMES = [
  "default",
  "browser",
  "desktop",
  "direct",
  "pool",
  "template",
  "rt",
] as const;

/** One named runtime, as the chart renders it into `PI_SANDBOX_RUNTIMES` (`sandbox.runtimes`). */
export interface SandboxRuntime {
  runtimeClassName: string;
  /** The class is not gVisor (neither `gvisor` nor `gvisor-*`). */
  insecure: boolean;
  /** Flavours that have a pool under this runtime. */
  flavours: string[];
}

export type SandboxRuntimes = Record<string, SandboxRuntime>;

const ENV = "PI_SANDBOX_RUNTIMES";

/**
 * The named runtimes from `PI_SANDBOX_RUNTIMES`: a JSON object `{"<name>":{"runtimeClassName","insecure","flavours"}}`.
 * Absent or empty is `{}`. A malformed value throws, so a process refuses to start rather than accept wrong names.
 */
export function parseSandboxRuntimes(env: NodeJS.ProcessEnv): SandboxRuntimes {
  const raw = env[ENV]?.trim();
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${ENV} must be a JSON object`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${ENV} must be a JSON object`);
  }
  const runtimes: SandboxRuntimes = {};
  for (const [name, spec] of Object.entries(parsed as Record<string, unknown>)) {
    if (
      !SANDBOX_RUNTIME_NAME.test(name) ||
      (RESERVED_SANDBOX_RUNTIME_NAMES as readonly string[]).includes(name)
    ) {
      throw new Error(`${ENV}: "${name}" is not a runtime name`);
    }
    if (spec === null || typeof spec !== "object" || Array.isArray(spec)) {
      throw new Error(`${ENV}: runtime "${name}" must be an object`);
    }
    const entry = spec as Record<string, unknown>;
    for (const key of Object.keys(entry)) {
      if (key !== "runtimeClassName" && key !== "insecure" && key !== "flavours") {
        throw new Error(`${ENV}: runtime "${name}" has an unknown field "${key.slice(0, 50)}"`);
      }
    }
    const { runtimeClassName, insecure, flavours } = entry;
    if (typeof runtimeClassName !== "string" || runtimeClassName === "") {
      throw new Error(`${ENV}: runtime "${name}" needs a non-empty runtimeClassName`);
    }
    if (typeof insecure !== "boolean") {
      throw new Error(`${ENV}: runtime "${name}" needs insecure true or false`);
    }
    if (
      !Array.isArray(flavours) ||
      flavours.length === 0 ||
      !flavours.every((flavour): flavour is string => typeof flavour === "string" && flavour !== "")
    ) {
      throw new Error(`${ENV}: runtime "${name}" needs flavours, a non-empty list of names`);
    }
    runtimes[name] = { runtimeClassName, insecure, flavours: [...flavours] };
  }
  return runtimes;
}

/** The runtime name a profile definition asks for, or null for the default runtime. */
export const sandboxRuntimeOf = (definition: {
  sandboxRuntime?: string | undefined;
}): string | null => definition.sandboxRuntime ?? null;

/**
 * Why a profile cannot use its `sandboxRuntime` on this deployment, or null. Checked at profile write and again at
 * session create (the deployment may change in between). A profile without `sandboxRuntime` has no conflict: it runs on
 * the default runtime, which every flavour and network mode has.
 */
export function sandboxRuntimeConflict(
  profile: Pick<ProfileDefinition, "sandboxRuntime" | "sandboxFlavour" | "networkMode">,
  runtimes: SandboxRuntimes,
): string | null {
  const name = profile.sandboxRuntime;
  if (name === undefined) return null;
  const runtime = Object.hasOwn(runtimes, name) ? runtimes[name] : undefined;
  if (runtime === undefined) {
    const known = Object.keys(runtimes);
    return known.length === 0
      ? `sandboxRuntime "${name}" is not available: this deployment has not set sandbox.runtimes`
      : `sandboxRuntime "${name}" is not defined in sandbox.runtimes (defined: ${known.join(", ")})`;
  }
  const flavour = profile.sandboxFlavour ?? "default";
  if (!runtime.flavours.includes(flavour)) {
    return `sandboxFlavour ${flavour} is not available on sandboxRuntime "${name}" (sandbox.runtimes.${name}.flavours: ${runtime.flavours.join(", ")})`;
  }
  if (profile.networkMode === "direct") {
    return `networkMode direct cannot be combined with sandboxRuntime "${name}" (named runtimes are proxied only)`;
  }
  return null;
}
