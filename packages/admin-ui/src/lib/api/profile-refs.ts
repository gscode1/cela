import { adminJson } from "@/lib/api/raw";

/** What the catalog screens need of a profile: which skill versions and MCP servers its current definition names. */
export interface ProfileRef {
  name: string;
  enabledForNew: boolean;
  skills: { name: string; version: number }[];
  mcpServers: string[];
}

interface ProfilesAnswer {
  profiles: {
    name: string;
    enabledForNew: boolean;
    definition: {
      skills?: { name: string; version: number }[];
      mcpServers?: string[];
    };
  }[];
}

/**
 * A read-only view of `GET /admin/profiles` for the reference lists of the skill and MCP screens. The profile screens
 * have their own module; this one only reads.
 */
export async function listProfileRefs(token: string, signal?: AbortSignal): Promise<ProfileRef[]> {
  const body = await adminJson<ProfilesAnswer>(token, "/admin/profiles", signal ? { signal } : {});
  return body.profiles.map((profile) => ({
    name: profile.name,
    enabledForNew: profile.enabledForNew,
    skills: (profile.definition.skills ?? []).map(({ name, version }) => ({ name, version })),
    mcpServers: profile.definition.mcpServers ?? [],
  }));
}

export const profilesWithMcp = (profiles: readonly ProfileRef[], server: string): ProfileRef[] =>
  profiles.filter((profile) => profile.mcpServers.includes(server));

export const profilesPinning = (
  profiles: readonly ProfileRef[],
  skill: string,
  version: number,
): ProfileRef[] =>
  profiles.filter((profile) =>
    profile.skills.some((pin) => pin.name === skill && pin.version === version),
  );
