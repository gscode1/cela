import { adminFetch, adminPut } from "@/lib/api";
import type { AdminSettings } from "@/lib/api";

/** Reasoning levels, lowest to highest (packages/session-core/src/models.ts, `THINKING_LEVELS`). */
export const REASONING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

/** The settings a write may carry: what `PUT /admin/settings` accepts, without `expectedRevision`. */
export interface SettingsValues {
  defaultModel: string;
  allowlist: string[];
  reasoning: ReasoningLevel | null;
  maxReasoning: ReasoningLevel | null;
  defaultProfile: string;
  turnBudget: number;
  /** Null: no limit. */
  tokenBudget: number | null;
}

/** One row of `GET /admin/settings/history`; `old` is null for the seed. */
export interface SettingsHistoryEntry {
  id: string;
  changedAt: string;
  changedBy: string;
  old: SettingsValues | null;
  new: SettingsValues;
}

export function valuesOf(settings: AdminSettings): SettingsValues {
  return {
    defaultModel: settings.defaultModel,
    allowlist: settings.allowlist,
    reasoning: asLevel(settings.reasoning),
    maxReasoning: asLevel(settings.maxReasoning),
    defaultProfile: settings.defaultProfile ?? "",
    turnBudget: settings.turnBudget,
    tokenBudget: settings.tokenBudget ?? null,
  };
}

function asLevel(value: string | null): ReasoningLevel | null {
  return REASONING_LEVELS.find((level) => level === value) ?? null;
}

export async function getSettingsHistory(
  token: string,
  signal?: AbortSignal,
): Promise<SettingsHistoryEntry[]> {
  const body = await adminFetch<{ history: SettingsHistoryEntry[] }>(
    token,
    "/admin/settings/history?limit=20",
    signal ? { signal } : {},
  );
  return body.history;
}

/** Sends every field, so a cleared `reasoning` or `maxReasoning` goes as `null`, with the revision the draft started from. */
export function putSettings(
  token: string,
  values: SettingsValues,
  expectedRevision: number,
): Promise<AdminSettings> {
  return adminPut<AdminSettings>(token, "/admin/settings", { ...values, expectedRevision });
}
