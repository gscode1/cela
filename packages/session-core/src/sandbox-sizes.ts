import type { ProfileDefinition } from "./profiles.js";

/** A size name: also the suffix of its SandboxTemplate and SandboxWarmPool (`pi-env-pool-<name>`). */
export const SANDBOX_SIZE_NAME = /^[a-z][a-z0-9-]{0,15}$/;

/** One operator-defined sandbox size (docs/decisions/0030-sandbox-sizes.md), as the chart renders it. */
export interface SandboxSize {
  name: string;
  requests: { cpu?: string; memory?: string };
  limits: { cpu?: string; memory?: string };
  workspaceSize: string;
  ephemeralStorage: string;
}

export interface SandboxSizes {
  /** Sorted by name. */
  sizes: SandboxSize[];
  defaultSize: string;
}

/** A Kubernetes quantity as the chart's JSON holds it: a string, or a number for a bare `cpu: 2`. */
function quantity(where: string, value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  throw new Error(`PI_SANDBOX_SIZES: ${where} must be a quantity`);
}

function quantities(where: string, value: unknown): { cpu?: string; memory?: string } {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object") throw new Error(`PI_SANDBOX_SIZES: ${where} must be an object`);
  const { cpu, memory } = value as Record<string, unknown>;
  const out: { cpu?: string; memory?: string } = {};
  if (cpu !== undefined) out.cpu = quantity(`${where}.cpu`, cpu);
  if (memory !== undefined) out.memory = quantity(`${where}.memory`, memory);
  return out;
}

/**
 * The sizes from `PI_SANDBOX_SIZES` (the chart's `sandbox.sizes` as JSON) and `PI_SANDBOX_DEFAULT_SIZE`. Undefined when
 * the deployment sets neither: sessions then get no size and the orchestrator uses the unsized `pi-env-pool`, as
 * before sizes existed. A malformed value throws, so ingest refuses to start rather than accept wrong names.
 */
export function parseSandboxSizes(env: NodeJS.ProcessEnv): SandboxSizes | undefined {
  const raw = env.PI_SANDBOX_SIZES?.trim();
  const defaultSize = env.PI_SANDBOX_DEFAULT_SIZE?.trim();
  if (!raw && !defaultSize) return undefined;
  if (!raw || !defaultSize) {
    throw new Error("PI_SANDBOX_SIZES and PI_SANDBOX_DEFAULT_SIZE must be set together");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("PI_SANDBOX_SIZES must be a JSON object");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("PI_SANDBOX_SIZES must be a JSON object");
  }
  const sizes: SandboxSize[] = [];
  for (const [name, spec] of Object.entries(parsed as Record<string, unknown>)) {
    if (!SANDBOX_SIZE_NAME.test(name))
      throw new Error(`PI_SANDBOX_SIZES: "${name}" is not a size name`);
    if (spec === null || typeof spec !== "object") {
      throw new Error(`PI_SANDBOX_SIZES: size "${name}" must be an object`);
    }
    const { resources, workspaceSize, ephemeralStorage } = spec as Record<string, unknown>;
    const { requests, limits } = (resources ?? {}) as Record<string, unknown>;
    sizes.push({
      name,
      requests: quantities(`${name}.resources.requests`, requests),
      limits: quantities(`${name}.resources.limits`, limits),
      workspaceSize: quantity(`${name}.workspaceSize`, workspaceSize),
      ephemeralStorage: quantity(`${name}.ephemeralStorage`, ephemeralStorage),
    });
  }
  if (sizes.length === 0) throw new Error("PI_SANDBOX_SIZES must define at least one size");
  sizes.sort((a, b) => a.name.localeCompare(b.name));
  if (!sizes.some((size) => size.name === defaultSize)) {
    throw new Error(`PI_SANDBOX_DEFAULT_SIZE "${defaultSize}" is not one of PI_SANDBOX_SIZES`);
  }
  return { sizes, defaultSize };
}

/**
 * The size a new session gets: the request's, else the profile's `sandboxSize`, else the deployment default. A caller
 * may only ask for one of the profile's `sandboxSizes` or its default; whatever is chosen must exist here. Returns null
 * when the deployment has no sizes and nothing asked for one, and a message for a 400 otherwise.
 */
export function chooseSandboxSize(
  sizes: SandboxSizes | undefined,
  definition: ProfileDefinition,
  requested: unknown,
): { size: string | null } | { error: string } {
  if (
    requested !== undefined &&
    (typeof requested !== "string" || !SANDBOX_SIZE_NAME.test(requested))
  ) {
    return { error: "sandboxSize must be a size name" };
  }
  if (sizes === undefined) {
    if (requested !== undefined || definition.sandboxSize !== undefined) {
      return { error: "this deployment defines no sandbox sizes" };
    }
    return { size: null };
  }
  const profileDefault = definition.sandboxSize ?? sizes.defaultSize;
  const size = requested ?? profileDefault;
  const allowed = new Set([profileDefault, ...(definition.sandboxSizes ?? [])]);
  if (!allowed.has(size)) {
    return {
      error: `sandboxSize "${size}" is not allowed by the profile (allowed: ${[...allowed].sort().join(", ")})`,
    };
  }
  if (!sizes.sizes.some((known) => known.name === size)) {
    return { error: `sandboxSize "${size}" is not defined in this deployment` };
  }
  return { size };
}
