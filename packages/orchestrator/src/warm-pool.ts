import type { NetworkMode } from "@pi-durable-k8s/session-core";

/**
 * The SandboxWarmPool of a new claim: one pool per size and network mode (docs/decisions/0030-sandbox-sizes.md,
 * 0038-network-modes.md). The pool's template bakes in the `pi-durable.dev/network-mode` label the NetworkPolicies
 * select on, so choosing the pool is choosing the network position; no Pod is patched afterwards. `base` is the
 * unsized proxied pool (`pi-env-pool`); direct pools sit beside it as `pi-env-direct-pool[-<size>]`, a name no size can
 * collide with. A session without a size (older than sizes) uses the unsized pool of its mode.
 */
export function warmPoolFor(base: string, size: string | null, mode: NetworkMode): string {
  const name = mode === "direct" ? directBase(base) : base;
  return size === null ? name : `${name}-${size}`;
}

/** `pi-env-pool` becomes `pi-env-direct-pool`; a base named otherwise gets `-direct` in front of `-pool`'s place. */
function directBase(base: string): string {
  return base.includes("-pool") ? base.replace("-pool", "-direct-pool") : `${base}-direct`;
}
