import { MCP_SERVER_NAME } from "./mcp-servers.js";

/**
 * The header the orchestrator sets on every request to the session mail server (docs/session-mail.md, ADR 0066). Its
 * value is the session's MCP agent identifier; the server scopes every mail lookup by it.
 */
export const MAIL_OWNER_HEADER = "X-Cela-Mail-Owner";

/**
 * The reserved catalog name of the session mail server (`PI_SESSION_MAIL_SERVER`, the chart's `sessionMail.server`), or
 * undefined for an unset or blank value: the feature is off then, and no profile or session has the exception. A name
 * that cannot be a catalog name is a mistake to refuse at start-up, not a setting that silently never matches.
 */
export function parseSessionMailServer(value: string | undefined): string | undefined {
  const name = value?.trim();
  if (name === undefined || name === "") return undefined;
  if (!MCP_SERVER_NAME.test(name)) {
    throw new Error(`PI_SESSION_MAIL_SERVER must match ${MCP_SERVER_NAME.source}`);
  }
  return name;
}
