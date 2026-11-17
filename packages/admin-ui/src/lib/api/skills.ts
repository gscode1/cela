import { adminJson, adminRequest } from "@/lib/api/raw";
import type { CatalogSource } from "@/lib/api/mcp";

export interface SkillFileEntry {
  path: string;
  size: number;
  sha256: string;
  executable: boolean;
}

/** One row of `GET /admin/skills`: a skill at its current version. */
export interface SkillSummary {
  name: string;
  currentVersion: number;
  digest: string;
  description: string;
  disableModelInvocation: boolean;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

export interface SkillVersion {
  name: string;
  version: number;
  digest: string;
  description: string;
  disableModelInvocation: boolean;
  size: number;
  files: SkillFileEntry[];
  source: CatalogSource | null;
  createdAt: string;
  createdBy: string;
}

export interface SkillDetail {
  name: string;
  currentVersion: number;
  versions: SkillVersion[];
}

/** The same version with `?content=true`: each file also carries its bytes as base64. */
export interface SkillVersionContent extends Omit<SkillVersion, "files"> {
  files: (SkillFileEntry & { contentBase64: string | null })[];
}

/** One file of a publish body: text goes as `content`, anything else as `contentBase64`. */
export type PublishFile =
  | { path: string; content: string; executable?: boolean }
  | { path: string; contentBase64: string; executable?: boolean };

export interface PublishResult {
  /** `false`: the API answered `200`, the content equals the current version and nothing was written. */
  created: boolean;
  version: SkillVersion;
}

const skillPath = (name: string): string => `/admin/skills/${encodeURIComponent(name)}`;

export async function listSkills(token: string, signal?: AbortSignal): Promise<SkillSummary[]> {
  const body = await adminJson<{ skills: SkillSummary[] }>(
    token,
    "/admin/skills",
    signal ? { signal } : {},
  );
  return body.skills;
}

/** `404` (an `ApiError`) when the skill does not exist yet, as before a first publish. */
export async function getSkill(
  token: string,
  name: string,
  signal?: AbortSignal,
): Promise<SkillDetail> {
  return adminJson<SkillDetail>(token, skillPath(name), signal ? { signal } : {});
}

export function getSkillVersionContent(
  token: string,
  name: string,
  version: number,
  signal?: AbortSignal,
): Promise<SkillVersionContent> {
  return adminJson<SkillVersionContent>(
    token,
    `${skillPath(name)}/versions/${String(version)}?content=true`,
    signal ? { signal } : {},
  );
}

export async function publishSkillVersion(
  token: string,
  name: string,
  files: PublishFile[],
): Promise<PublishResult> {
  const res = await adminRequest(token, `${skillPath(name)}/versions`, {
    method: "POST",
    body: { files },
  });
  const body = (await res.json()) as SkillVersion & { versionCreated?: boolean };
  return { created: res.status === 201, version: body };
}

/**
 * The zip of a version, saved through a temporary link. The route needs the bearer header, so the browser cannot
 * simply follow a link to it.
 */
export async function downloadSkillZip(
  token: string,
  name: string,
  version: number,
): Promise<void> {
  const res = await adminRequest(token, `${skillPath(name)}/versions/${String(version)}/zip`);
  const url = URL.createObjectURL(await res.blob());
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = `${name}-v${String(version)}.zip`;
    document.body.append(link);
    link.click();
    link.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}
