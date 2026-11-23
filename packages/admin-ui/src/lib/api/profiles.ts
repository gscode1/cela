import { adminFetch, adminPut } from "@/lib/api";
import type { ReasoningLevel } from "@/lib/api/settings";

/** A pinned skill version. `digest` is filled in by the API on write (docs/session-api.md, Session profiles). */
export interface SkillPin {
  name: string;
  version: number;
  digest?: string;
}

/**
 * What a profile decides, as the admin API reads and writes it (packages/session-core/src/profiles.ts,
 * `ProfileDefinition`). Every field is optional and absent differs from empty: absent `tools` is "all", `[]` is "none".
 */
export interface ProfileDefinition {
  tools?: string[];
  modelTools?: string[];
  instructions?: string;
  defaultModel?: string;
  reasoning?: ReasoningLevel;
  turnBudget?: number;
  tokenBudget?: number;
  mcpServers?: string[];
  /** Names of egress rule sets; the sets that apply to all sessions come on top (ADR 0034). */
  egressRuleSets?: string[];
  skills?: SkillPin[];
  repoSkills?: boolean;
  repoContext?: boolean;
  sandboxSize?: string;
  sandboxSizes?: string[];
  /** `proxied` (the default) or `direct` (open internet, unfiltered and unaudited; ADR 0038). */
  networkMode?: NetworkMode;
  /** `default` or `browser` (Chromium and browser tools; ADR 0041). */
  sandboxFlavour?: SandboxFlavour;
  /** A named runtime of the deployment's `sandbox.runtimes`; absent: the default runtime. */
  sandboxRuntime?: string;
}

export interface SandboxRuntimeCatalog {
  runtimes: { name: string; flavours: string[]; insecure: boolean }[];
  defaultRuntime: string;
}

export function listSandboxRuntimes(
  token: string,
  signal?: AbortSignal,
): Promise<SandboxRuntimeCatalog> {
  return adminFetch<SandboxRuntimeCatalog>(
    token,
    "/admin/sandbox-runtimes",
    signal ? { signal } : {},
  );
}

export type SandboxFlavour = "default" | "browser";

export interface SandboxFlavourCatalog {
  flavours: SandboxFlavour[];
  defaultFlavour: SandboxFlavour;
  /** The chart's sandbox.flavours.browser.enabled. */
  browserEnabled: boolean;
}

export function listSandboxFlavours(
  token: string,
  signal?: AbortSignal,
): Promise<SandboxFlavourCatalog> {
  return adminFetch<SandboxFlavourCatalog>(
    token,
    "/admin/sandbox-flavours",
    signal ? { signal } : {},
  );
}

export type NetworkMode = "proxied" | "direct";

export interface NetworkModeCatalog {
  modes: NetworkMode[];
  defaultMode: NetworkMode;
  /** The chart's security.allowDirectSandboxEgress. */
  directAllowed: boolean;
}

export function listNetworkModes(token: string, signal?: AbortSignal): Promise<NetworkModeCatalog> {
  return adminFetch<NetworkModeCatalog>(token, "/admin/network-modes", signal ? { signal } : {});
}

export interface StoredProfile {
  name: string;
  currentVersion: number;
  revision: number;
  enabledForNew: boolean;
  definition: ProfileDefinition;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

export interface InvalidProfile {
  name: string;
  message: string;
}

export interface ProfileList {
  defaultProfile: string;
  profiles: StoredProfile[];
  invalid: InvalidProfile[];
}

export interface ProfileVersion {
  version: number;
  definition: ProfileDefinition;
  createdAt: string;
  createdBy: string;
  /** Set when the stored version no longer validates; `definition` is then empty. */
  invalid?: string;
}

export interface ProfileDetail extends StoredProfile {
  versions: ProfileVersion[];
}

export interface PutProfileResult extends StoredProfile {
  versionCreated: boolean;
}

export interface ToolCatalog {
  tools: string[];
  source: "orchestrator" | "builtin";
}

export function listProfiles(token: string, signal?: AbortSignal): Promise<ProfileList> {
  return adminFetch<ProfileList>(token, "/admin/profiles", signal ? { signal } : {});
}

export function getProfile(
  token: string,
  name: string,
  signal?: AbortSignal,
): Promise<ProfileDetail> {
  return adminFetch<ProfileDetail>(
    token,
    `/admin/profiles/${encodeURIComponent(name)}`,
    signal ? { signal } : {},
  );
}

/** One operator-defined sandbox size (`GET /admin/sandbox-sizes`, docs/decisions/0030-sandbox-sizes.md). */
export interface SandboxSize {
  name: string;
  requests: { cpu?: string; memory?: string };
  limits: { cpu?: string; memory?: string };
  workspaceSize: string;
  ephemeralStorage: string;
}

/** `defaultSize` is null when the deployment defines no sizes. */
export interface SandboxSizeCatalog {
  sizes: SandboxSize[];
  defaultSize: string | null;
}

export function listSandboxSizes(token: string, signal?: AbortSignal): Promise<SandboxSizeCatalog> {
  return adminFetch<SandboxSizeCatalog>(token, "/admin/sandbox-sizes", signal ? { signal } : {});
}

export function listTools(token: string, signal?: AbortSignal): Promise<ToolCatalog> {
  return adminFetch<ToolCatalog>(token, "/admin/tools", signal ? { signal } : {});
}

/**
 * A write to one profile. `expectedRevision` is left out only for a create (a revision of a profile that does not exist
 * never matches). A definition goes whole: the API compares it with the current one and writes a version only when it
 * differs. `enabledForNew` alone changes no version.
 */
export interface PutProfileBody {
  definition?: ProfileDefinition;
  enabledForNew?: boolean;
  expectedRevision?: number;
}

export function putProfile(
  token: string,
  name: string,
  body: PutProfileBody,
): Promise<PutProfileResult> {
  return adminPut<PutProfileResult>(token, `/admin/profiles/${encodeURIComponent(name)}`, body);
}

/** Deletes a disabled profile that is not the default (ADR 0027); a refusal is an `ApiError` 409 with `blockedBy`. */
export function deleteProfile(
  token: string,
  name: string,
  expectedRevision: number,
): Promise<{ name: string; deleted: true; lastVersion: number }> {
  return adminFetch(
    token,
    `/admin/profiles/${encodeURIComponent(name)}?expectedRevision=${String(expectedRevision)}`,
    { method: "DELETE" },
  );
}

/*
 * Read-only views of the MCP catalog and the skills, for the editor's pickers. They are the editor's own so that the
 * MCP and skills screens keep their modules; they read the same endpoints (docs/session-api.md).
 */

export interface McpServerRef {
  name: string;
  url: string;
  enabled: boolean;
}

export interface SkillFile {
  path: string;
  size: number;
  executable: boolean;
}

export interface SkillVersionInfo {
  version: number;
  digest: string;
  description: string;
  disableModelInvocation: boolean;
  files: SkillFile[];
}

export interface SkillInfo {
  name: string;
  currentVersion: number;
  versions: SkillVersionInfo[];
}

export async function listMcpServerRefs(
  token: string,
  signal?: AbortSignal,
): Promise<McpServerRef[]> {
  const body = await adminFetch<{ servers: McpServerRef[] }>(
    token,
    "/admin/mcp-servers",
    signal ? { signal } : {},
  );
  return body.servers.map(({ name, url, enabled }) => ({ name, url, enabled }));
}

/** Every skill with its versions and file manifests (one call for the list, one per skill for the versions). */
export async function listSkillInfos(token: string, signal?: AbortSignal): Promise<SkillInfo[]> {
  const init = signal ? { signal } : {};
  const list = await adminFetch<{ skills: { name: string }[] }>(token, "/admin/skills", init);
  return Promise.all(
    list.skills.map((skill) =>
      adminFetch<SkillInfo>(token, `/admin/skills/${encodeURIComponent(skill.name)}`, init),
    ),
  );
}
