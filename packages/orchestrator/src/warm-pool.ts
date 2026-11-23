import type { NetworkMode, SandboxFlavour } from "@cela/session-core";

/**
 * The SandboxWarmPool of a new claim: one pool per size and network mode (docs/decisions/0030-sandbox-sizes.md,
 * 0038-network-modes.md). The pool's template bakes in the `cela.dev/network-mode` label the NetworkPolicies
 * select on, so choosing the pool is choosing the network position; no Pod is patched afterwards. `base` is the
 * unsized proxied pool (`pi-env-pool`); direct pools sit beside it as `pi-env-direct-pool[-<size>]`, a name no size can
 * collide with. The browser flavour (ADR 0041) adds `-browser` after `pi-env`: `pi-env-browser-pool[-<size>]`,
 * `pi-env-browser-direct-pool[-<size>]`; no size name can collide either. The desktop flavour (ADR 0065) does the same with `-desktop`. A session without a size (older than sizes) uses the unsized pool of its mode.
 * A named sandbox runtime (ADR 0064) adds `-rt-<runtime>` right after `pi-env`: `pi-env-rt-<runtime>[-browser|-desktop]-pool[-<size>]`.
 * Runtime names have no hyphen and are never `browser`, `desktop`, `direct`, `pool` or `template`, so no name collides. `null` is the
 * default runtime, which has no infix, so every pool name from before runtimes stays valid. The chart renders no direct
 * pool for a named runtime; a direct mode with one names a pool that does not exist, and ingest refuses that combination.
 */
export function warmPoolFor(
  base: string,
  size: string | null,
  mode: NetworkMode,
  flavour: SandboxFlavour,
  runtime: string | null,
): string {
  const named = mode === "direct" ? directBase(base) : base;
  const flavoured = flavour === "default" ? named : flavourBase(named, flavour);
  const name = runtime === null ? flavoured : runtimeBase(flavoured, runtime);
  return size === null ? name : `${name}-${size}`;
}

/** `pi-env-pool` becomes `pi-env-rt-gvisorkvm-pool` and `pi-env-browser-pool` becomes `pi-env-rt-gvisorkvm-browser-pool` (ADR 0064). */
function runtimeBase(base: string, runtime: string): string {
  return base.replace(/^pi-env-/, `pi-env-rt-${runtime}-`);
}

/** `pi-env-pool` becomes `pi-env-browser-pool` and `pi-env-direct-pool` becomes `pi-env-browser-direct-pool` (ADR 0041, 0065). */
function flavourBase(base: string, flavour: Exclude<SandboxFlavour, "default">): string {
  return base.replace(/^pi-env-/, `pi-env-${flavour}-`);
}

/** `pi-env-pool` becomes `pi-env-direct-pool`; a base named otherwise gets `-direct` in front of `-pool`'s place. */
function directBase(base: string): string {
  return base.includes("-pool") ? base.replace("-pool", "-direct-pool") : `${base}-direct`;
}
