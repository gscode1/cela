const MIB = 1024 * 1024;

/** Memory the orchestrator needs with no bridge open: measured 115-147 MiB idle (2026-11-17), doubled. */
export const BASE_RESERVE_BYTES = 256 * MIB;
/** Memory one open env (a relay process and its broker state) adds: measured about 11 MiB, doubled. */
export const PER_BRIDGE_BYTES = 24 * MIB;

/**
 * Above this a "limit" is the kernel's spelling of "none": cgroup v1 reports a page-rounded 2^63, and some libuv
 * versions report 2^64-1 for cgroup v2 `max`. No container has a petabyte of memory.
 */
const NO_LIMIT_FROM_BYTES = 2 ** 50;

export type BridgeCapSource = "derived" | "explicit" | "unlimited";

export interface BridgeCap {
  /** Most envs open or opening at once; `Infinity` for no cap. */
  max: number;
  source: BridgeCapSource;
}

/**
 * The container memory limit in bytes, or undefined when there is none. `process.constrainedMemory()` returns 0 for
 * "no limit or unknown" (Node's documented value, seen on Node 26 on macOS), but cgroup limits that are not set can
 * come back as a huge number, so that is treated as no limit too.
 */
export function memoryLimitBytes(constrained: number | undefined): number | undefined {
  if (constrained === undefined || !Number.isFinite(constrained)) return undefined;
  if (constrained <= 0 || constrained >= NO_LIMIT_FROM_BYTES) return undefined;
  return constrained;
}

/**
 * Cap on open bridges from the `PI_MAX_OPEN_BRIDGES` text (ADR 0018): unset or `auto` derives it from the memory
 * limit, `0` is no cap, a whole number of 1 or more is used as given. Anything else throws, so a typo cannot silently
 * remove the memory bound.
 */
export function resolveBridgeCap(
  setting: string | undefined,
  memoryLimit: number | undefined,
): BridgeCap {
  if (setting === undefined || setting === "auto") {
    if (memoryLimit === undefined) return { max: Infinity, source: "unlimited" };
    const fit = Math.floor((memoryLimit - BASE_RESERVE_BYTES) / PER_BRIDGE_BYTES);
    // A limit below the reserve still gets one slot: zero would deadlock every tool call.
    return { max: Math.max(1, fit), source: "derived" };
  }
  if (!/^\d+$/.test(setting))
    throw new Error('PI_MAX_OPEN_BRIDGES must be "auto", 0 (no cap) or an integer of 1 or more');
  const value = Number(setting);
  if (!Number.isSafeInteger(value))
    throw new Error('PI_MAX_OPEN_BRIDGES must be "auto", 0 (no cap) or an integer of 1 or more');
  return value === 0 ? { max: Infinity, source: "unlimited" } : { max: value, source: "explicit" };
}

/** A cap as a log field: `Infinity` would serialise as null. */
export function capField(max: number): number | "unlimited" {
  return Number.isFinite(max) ? max : "unlimited";
}

/** The `bridge-cap` start line (docs/metrics.md). `level` is `warn` when nothing bounds the bridges. */
export function bridgeCapFields(
  max: number,
  source: BridgeCapSource,
  limit: number | undefined,
): Record<string, unknown> {
  const noLimit = source === "unlimited" && limit === undefined;
  return {
    ...(noLimit ? { level: "warn", warning: "no memory limit: open bridges are not bounded" } : {}),
    max: capField(max),
    source,
    memoryLimitBytes: limit ?? null,
    reserveBytes: BASE_RESERVE_BYTES,
    perBridgeBytes: PER_BRIDGE_BYTES,
  };
}
