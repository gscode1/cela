/** One line per built-in tool (names as `GET /admin/tools` lists them). A tool that is not here has no description. */
const TOOL_DESCRIPTIONS: Readonly<Record<string, string>> = {
  read: "Read files",
  write: "Create or overwrite files",
  edit: "Change part of a file",
  bash: "Run shell commands",
  grep: "Search file contents",
  find: "Find files by name",
  ls: "List directories",
};

export const toolDescription = (name: string): string | undefined => TOOL_DESCRIPTIONS[name];
