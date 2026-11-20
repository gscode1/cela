const DEFAULT_MAX_SESSIONS = 20;

export interface McpConfig {
  /** Base URL of the session API, without a trailing slash. */
  apiUrl: string;
  /** Bearer token. Never log it or put it in an error. */
  token: string;
  /** Most sessions this process may create. */
  maxSessions: number;
  admin?: { token: string; writes: boolean };
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function isLoopback(hostname: string): boolean {
  // URL keeps the brackets of an IPv6 host.
  return hostname === "localhost" || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

function parseApiUrl(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === "") throw new ConfigError("PI_API_URL is required");
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ConfigError("PI_API_URL is not a valid URL");
  }
  if (url.username !== "" || url.password !== "") {
    throw new ConfigError("PI_API_URL must not contain credentials");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new ConfigError("PI_API_URL must be https (http is only allowed for loopback hosts)");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new ConfigError("PI_API_URL must not have a query or fragment");
  }
  return url.href.replace(/\/+$/, "");
}

function parseMaxSessions(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_MAX_SESSIONS;
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ConfigError("PI_MCP_MAX_SESSIONS must be a positive integer");
  }
  return value;
}

/** Errors name the variable, never its value: PI_API_TOKEN must not leak through a message. */
export function parseConfig(env: Record<string, string | undefined>): McpConfig {
  const apiUrl = parseApiUrl(env.PI_API_URL);
  const token = env.PI_API_TOKEN?.trim();
  if (token === undefined || token === "") throw new ConfigError("PI_API_TOKEN is required");
  // A token with whitespace or control characters cannot be a valid header value.
  if (!/^[\x21-\x7e]+$/.test(token)) {
    throw new ConfigError("PI_API_TOKEN contains characters not allowed in a bearer token");
  }
  const flag = (name: string): boolean => {
    const value = env[name];
    if (value === undefined || value === "false") return false;
    if (value === "true") return true;
    throw new ConfigError(`${name} must be true or false`);
  };
  const enabled = flag("PI_MCP_ADMIN");
  const writes = flag("PI_MCP_ADMIN_WRITES");
  if (writes && !enabled) throw new ConfigError("PI_MCP_ADMIN_WRITES requires PI_MCP_ADMIN");
  let admin: McpConfig["admin"];
  if (enabled) {
    const adminToken = env.PI_API_ADMIN_TOKEN?.trim();
    if (adminToken === undefined || adminToken === "") throw new ConfigError("PI_API_ADMIN_TOKEN is required");
    if (!/^[\x21-\x7e]+$/.test(adminToken)) throw new ConfigError("PI_API_ADMIN_TOKEN contains characters not allowed in a bearer token");
    admin = { token: adminToken, writes };
  }
  return { apiUrl, token, maxSessions: parseMaxSessions(env.PI_MCP_MAX_SESSIONS), ...(admin === undefined ? {} : { admin }) };
}
