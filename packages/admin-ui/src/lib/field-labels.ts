/**
 * One name per field across forms, review tables, history and version diffs. API keys never reach the operator.
 * A field missing here falls back to its key, so a new API field still shows up.
 */
const FIELD_LABELS: Readonly<Record<string, string>> = {
  // Global settings
  defaultModel: "Default model",
  allowlist: "Allowed models",
  reasoning: "Default reasoning",
  maxReasoning: "Highest reasoning allowed",
  defaultProfile: "Default profile",
  turnBudget: "Turn budget",
  tokenBudget: "Token budget",
  repoAllowlist: "Allowed repositories",
  // Profiles
  instructions: "Instructions",
  tools: "Tools",
  modelTools: "Tools the model can call",
  mcpServers: "MCP servers",
  egressRuleSets: "Egress rule sets",
  skills: "Skills",
  repoSkills: "Skills from the repository",
  repoContext: "Repository instructions (AGENTS.md)",
  sandboxSize: "Sandbox size",
  sandboxSizes: "Sizes a session may ask for",
  enabledForNew: "Available to new sessions",
  // MCP servers
  url: "URL",
  readOnly: "Read-only",
  timeoutMs: "Timeout",
  maxOutputBytes: "Max output",
  enabled: "Enabled",
};

export function fieldLabel(key: string): string {
  return FIELD_LABELS[key] ?? key;
}
