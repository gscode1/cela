import type pg from "pg";
import { clearMcpDiscovery, recordMcpDiscovery } from "@pi-durable-k8s/session-core";
import { errorMessage, log } from "./log.js";
import type { McpStatusReport, McpStatusSink } from "./mcp.js";

/** What an admin reads of a failure: enough for "timed out" or "403 from the gateway", not a stack or a response body. */
export const MAX_DISCOVERY_ERROR_LENGTH = 300;

const REDACTED = "[redacted]";

/**
 * Error text of a failed discovery goes to the admin API, so it must not carry a credential even if a transport or the
 * gateway echoes one: injected headers, bearer tokens, URL userinfo, secret query parameters and long opaque strings
 * are replaced, whitespace is collapsed and the text is cut to `MAX_DISCOVERY_ERROR_LENGTH`.
 */
export function sanitizeDiscoveryError(message: string): string {
  const cleaned = message
    // A header line or `name=value` pair of a credential header: the rest of the line is its value.
    .replace(
      /\b(authorization|proxy-authorization|x-api-key|api-key|cookie|set-cookie|x-onecli-[\w-]*|x-[\w-]*(?:token|secret|key))\s*[:=]\s*[^\r\n,;]*/gi,
      `$1: ${REDACTED}`,
    )
    .replace(/\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{6,}/gi, `$1 ${REDACTED}`)
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, `$1${REDACTED}@`)
    .replace(
      /([?&](?:token|access_token|id_token|api[_-]?key|key|secret|password|sig|signature|auth|code)=)[^&\s]*/gi,
      `$1${REDACTED}`,
    )
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]*/g, REDACTED)
    .replace(/\b(?:oc|sk|pk|ghp|gho|ghs|ghu|github_pat|xox[a-z])[_-][A-Za-z0-9_-]{8,}/g, REDACTED)
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, REDACTED)
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length <= MAX_DISCOVERY_ERROR_LENGTH
    ? cleaned
    : `${cleaned.slice(0, MAX_DISCOVERY_ERROR_LENGTH - 1)}…`;
}

/**
 * Publishes discovery outcomes into this shard's status row (ADR 0044). Writes run one after another in the order the
 * outcomes happened, so a late `ready` cannot overwrite the `removed` of a server that was replaced meanwhile. A
 * failed write is logged and dropped: status is for admins and must never stop discovery or serving.
 */
export function mcpStatusRecorder(pool: pg.Pool, shard: number): McpStatusSink {
  let last: Promise<void> = Promise.resolve();
  const write = (report: McpStatusReport): Promise<void> => {
    switch (report.state) {
      case "ready":
        return recordMcpDiscovery(pool, shard, report.server, {
          state: "ready",
          tools: report.toolNames.length,
          toolNames: report.toolNames,
        });
      case "failed":
        return recordMcpDiscovery(pool, shard, report.server, {
          state: "failed",
          error: sanitizeDiscoveryError(report.message),
        });
      case "removed":
        return clearMcpDiscovery(pool, shard, report.server);
    }
  };
  return (report) => {
    last = last.then(() =>
      write(report).catch((error: unknown) => {
        log("mcp-status-write-failed", { server: report.server, message: errorMessage(error) });
      }),
    );
  };
}
