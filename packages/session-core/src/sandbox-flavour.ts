import { credentialSource } from "./network-mode.js";
import type { StoredMcpServer } from "./mcp-servers.js";
import type { EgressData } from "./egress-store.js";
import type { ProfileDefinition } from "./profiles.js";

/**
 * Which image and resources a session's sandbox has (docs/decisions/0041-browser-sandbox.md). `default`: the sandbox
 * image. `browser`: the same plus Chromium and two browser tools, behind the chart value
 * `sandbox.flavours.browser.enabled`. `desktop`: the same plus a virtual X desktop with a few apps and agent-desktop
 * (docs/decisions/0065-desktop-sandbox.md), behind `sandbox.flavours.desktop.enabled`. Chosen by the profile, fixed per session, like the network mode.
 */
export const SANDBOX_FLAVOURS = ["default", "browser", "desktop"] as const;
export type SandboxFlavour = (typeof SANDBOX_FLAVOURS)[number];
export const DEFAULT_SANDBOX_FLAVOUR: SandboxFlavour = "default";

export const isSandboxFlavour = (value: unknown): value is SandboxFlavour =>
  typeof value === "string" && (SANDBOX_FLAVOURS as readonly string[]).includes(value);

/** The flavour a profile definition asks for; absent is `default`. */
export const sandboxFlavourOf = (definition: ProfileDefinition): SandboxFlavour =>
  definition.sandboxFlavour ?? DEFAULT_SANDBOX_FLAVOUR;

/**
 * Flavours that open untrusted content (web pages, documents): nothing they hold may be worth stealing, so they get no
 * repo, no credentialed MCP server (but the session mail server for the browser flavour, ADR 0067) and no `onecli`
 * route (ADR 0041, 0065).
 */
export const UNTRUSTED_CONTENT_FLAVOURS = ["browser", "desktop"] as const;
export type UntrustedContentFlavour = (typeof UNTRUSTED_CONTENT_FLAVOURS)[number];

export const isUntrustedContentFlavour = (value: unknown): value is UntrustedContentFlavour =>
  typeof value === "string" && (UNTRUSTED_CONTENT_FLAVOURS as readonly string[]).includes(value);

export const flavourNotEnabled = (flavour: UntrustedContentFlavour): string =>
  `sandboxFlavour ${flavour} is not available: this deployment has not set sandbox.flavours.${flavour}.enabled`;

export const BROWSER_NOT_ENABLED = flavourNotEnabled("browser");
export const DESKTOP_NOT_ENABLED = flavourNotEnabled("desktop");

/**
 * Why an untrusted-content session cannot have this profile, or undefined: no credentialed MCP server and no `onecli`
 * route (a repo is checked by the caller, it is not part of the profile). Profiles of other flavours have no conflict.
 * `mailServer` (the deployment's session mail server, ADR 0067) is the one credentialed server a browser profile may
 * name; a desktop profile may not.
 */
export function untrustedFlavourConflict(
  definition: ProfileDefinition,
  state: { mcpServers: readonly StoredMcpServer[]; egress: EgressData },
  mailServer?: string,
): string | undefined {
  const flavour = definition.sandboxFlavour;
  if (!isUntrustedContentFlavour(flavour)) return undefined;
  const source = credentialSource(
    definition,
    state,
    flavour === "browser" ? mailServer : undefined,
  );
  return source === undefined
    ? undefined
    : `sandboxFlavour ${flavour} cannot be combined with ${source}`;
}

export const flavourWithRepo = (flavour: UntrustedContentFlavour): string =>
  `sandboxFlavour ${flavour} cannot be combined with a repo (a ${flavour} session holds no credentials)`;
export const BROWSER_WITH_REPO = flavourWithRepo("browser");
export const DESKTOP_WITH_REPO = flavourWithRepo("desktop");
