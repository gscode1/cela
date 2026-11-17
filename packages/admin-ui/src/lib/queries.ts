import { useQuery } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";
import { useAuth } from "@/auth";
import { getSettings } from "@/lib/api";
import type { AdminSettings } from "@/lib/api";
import {
  getProfile,
  listMcpServerRefs,
  listProfiles,
  listSkillInfos,
  listTools,
} from "@/lib/api/profiles";
import type {
  McpServerRef,
  ProfileDetail,
  ProfileList,
  SkillInfo,
  ToolCatalog,
} from "@/lib/api/profiles";
import { getSettingsHistory } from "@/lib/api/settings";
import type { SettingsHistoryEntry } from "@/lib/api/settings";

/**
 * Query keys. A write invalidates by prefix: `["settings"]` also covers its history, `["profiles"]` the list and every
 * `["profiles", name]`. The editor's pickers have their own keys so they never share a cache entry with the screens
 * of the MCP catalog and the skills.
 */
export const keys = {
  settings: ["settings"] as const,
  settingsHistory: ["settings", "history"] as const,
  profiles: ["profiles"] as const,
  profile: (name: string) => ["profiles", name] as const,
  tools: ["tools"] as const,
  pickerMcp: ["profile-editor", "mcp-servers"] as const,
  pickerSkills: ["profile-editor", "skills"] as const,
};

export function useSettingsQuery(): UseQueryResult<AdminSettings> {
  const { token } = useAuth();
  return useQuery({
    queryKey: keys.settings,
    queryFn: ({ signal }) => getSettings(token ?? "", signal),
  });
}

export function useSettingsHistoryQuery(): UseQueryResult<SettingsHistoryEntry[]> {
  const { token } = useAuth();
  return useQuery({
    queryKey: keys.settingsHistory,
    queryFn: ({ signal }) => getSettingsHistory(token ?? "", signal),
  });
}

export function useProfilesQuery(): UseQueryResult<ProfileList> {
  const { token } = useAuth();
  return useQuery({
    queryKey: keys.profiles,
    queryFn: ({ signal }) => listProfiles(token ?? "", signal),
  });
}

export function useProfileQuery(name: string): UseQueryResult<ProfileDetail> {
  const { token } = useAuth();
  return useQuery({
    queryKey: keys.profile(name),
    queryFn: ({ signal }) => getProfile(token ?? "", name, signal),
  });
}

export function useToolsQuery(): UseQueryResult<ToolCatalog> {
  const { token } = useAuth();
  return useQuery({
    queryKey: keys.tools,
    queryFn: ({ signal }) => listTools(token ?? "", signal),
  });
}

export function useMcpPickerQuery(): UseQueryResult<McpServerRef[]> {
  const { token } = useAuth();
  return useQuery({
    queryKey: keys.pickerMcp,
    queryFn: ({ signal }) => listMcpServerRefs(token ?? "", signal),
  });
}

export function useSkillPickerQuery(): UseQueryResult<SkillInfo[]> {
  const { token } = useAuth();
  return useQuery({
    queryKey: keys.pickerSkills,
    queryFn: ({ signal }) => listSkillInfos(token ?? "", signal),
  });
}
