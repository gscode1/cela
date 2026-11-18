import { useQuery } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";
import { useAuth } from "@/auth";
import { getSettings } from "@/lib/api";
import type { AdminSettings } from "@/lib/api";
import {
  getProfile,
  listMcpServerRefs,
  listProfiles,
  listNetworkModes,
  listSandboxSizes,
  listSkillInfos,
  listTools,
} from "@/lib/api/profiles";
import type {
  McpServerRef,
  ProfileDetail,
  ProfileList,
  NetworkModeCatalog,
  SandboxSizeCatalog,
  SkillInfo,
  ToolCatalog,
} from "@/lib/api/profiles";
import {
  getEgressStatus,
  getRuleSet,
  listEgressHistory,
  listRuleSets,
  listSessionRules,
} from "@/lib/api/egress";
import type {
  EgressHistoryEntry,
  EgressRule,
  EgressStatus,
  RuleSetDetail,
  RuleSetList,
} from "@/lib/api/egress";
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
  sandboxSizes: ["sandbox-sizes"] as const,
  networkModes: ["network-modes"] as const,
  pickerMcp: ["profile-editor", "mcp-servers"] as const,
  pickerSkills: ["profile-editor", "skills"] as const,
  /** A write invalidates `egress` as a whole: every egress view moves with the one schema revision. */
  egress: ["egress"] as const,
  egressRuleSets: ["egress", "rule-sets"] as const,
  egressRuleSet: (name: string) => ["egress", "rule-set", name] as const,
  egressSession: (id: string) => ["egress", "session", id] as const,
  egressStatus: ["egress", "status"] as const,
  egressHistory: ["egress", "history"] as const,
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

export function useSandboxSizesQuery(): UseQueryResult<SandboxSizeCatalog> {
  const { token } = useAuth();
  return useQuery({
    queryKey: keys.sandboxSizes,
    queryFn: ({ signal }) => listSandboxSizes(token ?? "", signal),
  });
}

export function useNetworkModesQuery(): UseQueryResult<NetworkModeCatalog> {
  const { token } = useAuth();
  return useQuery({
    queryKey: keys.networkModes,
    queryFn: ({ signal }) => listNetworkModes(token ?? "", signal),
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

export function useRuleSetsQuery(): UseQueryResult<RuleSetList> {
  const { token } = useAuth();
  return useQuery({
    queryKey: keys.egressRuleSets,
    queryFn: ({ signal }) => listRuleSets(token ?? "", signal),
  });
}

export function useRuleSetQuery(name: string): UseQueryResult<RuleSetDetail> {
  const { token } = useAuth();
  return useQuery({
    queryKey: keys.egressRuleSet(name),
    queryFn: ({ signal }) => getRuleSet(token ?? "", name, signal),
  });
}

export function useSessionRulesQuery(sessionId: string | undefined): UseQueryResult<{
  revision: number;
  rules: EgressRule[];
  networkMode: "proxied" | "direct" | null;
}> {
  const { token } = useAuth();
  return useQuery({
    queryKey: keys.egressSession(sessionId ?? ""),
    queryFn: ({ signal }) => listSessionRules(token ?? "", sessionId ?? "", signal),
    enabled: sessionId !== undefined,
  });
}

export function useEgressStatusQuery(): UseQueryResult<EgressStatus> {
  const { token } = useAuth();
  return useQuery({
    queryKey: keys.egressStatus,
    queryFn: ({ signal }) => getEgressStatus(token ?? "", signal),
  });
}

export function useEgressHistoryQuery(): UseQueryResult<EgressHistoryEntry[]> {
  const { token } = useAuth();
  return useQuery({
    queryKey: keys.egressHistory,
    queryFn: ({ signal }) => listEgressHistory(token ?? "", signal),
  });
}
