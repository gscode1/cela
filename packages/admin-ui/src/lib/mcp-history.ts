import { kbText, secondsText } from "@/lib/api/mcp";
import type { McpFields, McpHistoryEntry } from "@/lib/api/mcp";
import { fieldLabel } from "@/lib/field-labels";

/** `onecliSecret` is not shown anywhere in the console, so a change to it does not appear in the history either. */
const SHOWN: readonly (keyof McpFields)[] = [
  "url",
  "enabled",
  "readOnly",
  "timeoutMs",
  "maxOutputBytes",
];

function valueText(field: keyof McpFields, value: McpFields[keyof McpFields]): string {
  if (field === "timeoutMs") return secondsText(Number(value));
  if (field === "maxOutputBytes") return kbText(Number(value));
  if (field === "enabled") return value === true ? "enabled" : "disabled";
  if (field === "readOnly") return value === true ? "read-only" : "can change state";
  return String(value);
}

/** One line for a history entry: what happened to which server, in the console's field names. */
export function describeMcpChange(entry: McpHistoryEntry): string {
  if (entry.action === "create") return "created";
  if (entry.action === "delete") return "deleted";
  const { old: before, new: after } = entry;
  if (before === null || after === null) return "updated";
  const parts = SHOWN.filter((field) => before[field] !== after[field]).map(
    (field) =>
      `${field === "readOnly" ? "Access" : fieldLabel(field)}: ${valueText(field, before[field])} → ${valueText(field, after[field])}`,
  );
  return parts.length === 0 ? "updated" : parts.join("; ");
}
