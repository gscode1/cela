import { credentialSource } from "./network-mode.js";
import type { StoredMcpServer } from "./mcp-servers.js";
import type { EgressData } from "./egress-store.js";
import type { ProfileDefinition } from "./profiles.js";

/**
 * Which image and resources a session's sandbox has (docs/decisions/0041-browser-sandbox.md). `default`: the sandbox
 * image. `browser`: the same plus Chromium and two browser tools, behind the chart value
 * `sandbox.flavours.browser.enabled`. Chosen by the profile, fixed per session, like the network mode.
 */
export const SANDBOX_FLAVOURS = ["default", "browser"] as const;
export type SandboxFlavour = (typeof SANDBOX_FLAVOURS)[number];
export const DEFAULT_SANDBOX_FLAVOUR: SandboxFlavour = "default";

export const isSandboxFlavour = (value: unknown): value is SandboxFlavour =>
  typeof value === "string" && (SANDBOX_FLAVOURS as readonly string[]).includes(value);

/** The flavour a profile definition asks for; absent is `default`. */
export const sandboxFlavourOf = (definition: ProfileDefinition): SandboxFlavour =>
  definition.sandboxFlavour ?? DEFAULT_SANDBOX_FLAVOUR;

export const BROWSER_NOT_ENABLED =
  "sandboxFlavour browser is not available: this deployment has not set sandbox.flavours.browser.enabled";

/**
 * Why a browser session cannot have this profile, or undefined. A browser runs arbitrary web pages: nothing it holds
 * may be worth stealing, so it gets no repo (its credential is injected by the proxy), no credentialed MCP server and no
 * `onecli` route. A repo is checked by the caller (it is not part of the profile).
 */
export function browserFlavourConflict(
  definition: ProfileDefinition,
  state: { mcpServers: readonly StoredMcpServer[]; egress: EgressData },
): string | undefined {
  const source = credentialSource(definition, state);
  return source === undefined ? undefined : `sandboxFlavour browser cannot be combined with ${source}`;
}

export const BROWSER_WITH_REPO =
  "sandboxFlavour browser cannot be combined with a repo (a browser session holds no credentials)";
