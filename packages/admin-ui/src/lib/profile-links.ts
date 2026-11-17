import type { ProfileForm } from "@/lib/profile-form";

/**
 * What the skill and MCP screens ask the profile screens to preselect: `?pinSkill=<name>@<version>` after a skill
 * publish, `?addMcp=<name>` after an MCP save. Both only prepare an unsaved draft; the operator publishes it.
 */
export interface ProfileIntent {
  pinSkill?: { name: string; version: number };
  addMcp?: string;
}

/** Reads the two parameters; a malformed value is ignored rather than guessed at. */
export function intentFromSearch(params: URLSearchParams): ProfileIntent {
  const intent: ProfileIntent = {};
  const pin = /^(.+)@([1-9]\d*)$/.exec(params.get("pinSkill") ?? "");
  if (pin?.[1] !== undefined && pin[2] !== undefined)
    intent.pinSkill = { name: pin[1], version: Number(pin[2]) };
  const mcp = params.get("addMcp");
  if (mcp !== null && mcp !== "") intent.addMcp = mcp;
  return intent;
}

export const hasIntent = (intent: ProfileIntent): boolean =>
  intent.pinSkill !== undefined || intent.addMcp !== undefined;

/** The query string that carries the intent on to a profile's own route. */
export function searchOf(intent: ProfileIntent): string {
  const params = new URLSearchParams();
  if (intent.pinSkill !== undefined)
    params.set("pinSkill", `${intent.pinSkill.name}@${String(intent.pinSkill.version)}`);
  if (intent.addMcp !== undefined) params.set("addMcp", intent.addMcp);
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
}

/** The sentence that says what the draft got, for the operator to check before publishing. */
export function describeIntent(intent: ProfileIntent): string {
  const parts: string[] = [];
  if (intent.pinSkill !== undefined)
    parts.push(`pin ${intent.pinSkill.name} v${String(intent.pinSkill.version)}`);
  if (intent.addMcp !== undefined) parts.push(`add the MCP server ${intent.addMcp}`);
  return parts.join(" and ");
}

/** The form with the intent applied: a pin of the same skill is replaced, a server already listed stays once. */
export function applyIntent(form: ProfileForm, intent: ProfileIntent): ProfileForm {
  let { skills, mcpServers } = form;
  const pin = intent.pinSkill;
  if (pin !== undefined)
    skills = skills.some((entry) => entry.name === pin.name)
      ? skills.map((entry) => (entry.name === pin.name ? pin : entry))
      : [...skills, pin];
  const server = intent.addMcp;
  if (server !== undefined && !mcpServers.includes(server)) mcpServers = [...mcpServers, server];
  return { ...form, skills, mcpServers };
}
