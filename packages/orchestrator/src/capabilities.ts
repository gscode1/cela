import type pg from "pg";
import {
  checkProfileNames,
  errorMessage,
  publishCapabilities,
  readProfiles,
} from "@pi-durable-k8s/session-core";
import { validateProfileDefinition } from "@pi-durable-k8s/session-core";
import type { Capabilities, ProfileDefinition } from "@pi-durable-k8s/session-core";
import { log } from "./log.js";

/**
 * At start: publishes the installed coding tools and extensions (ingest checks admin writes of profiles against them,
 * docs/decisions/0010-session-profiles.md) and logs every stored profile whose names do not resolve against them
 * (`profile-unresolved`). A tool that no longer exists leaves a session of that profile without it, never with more, so
 * this is a warning and never blocks the start. Returns the unresolved profile names.
 */
export async function publishAndCheckProfiles(
  pool: pg.Pool,
  capabilities: Capabilities,
  instance: string,
): Promise<string[]> {
  try {
    await publishCapabilities(pool, capabilities, instance);
    const catalog = await readProfiles(pool);
    for (const bad of catalog.invalid) log("profile-invalid", bad);
    const unresolved: string[] = [];
    for (const profile of catalog.profiles) {
      // MCP servers are checked at use (a catalog change needs no restart): only the tools are resolved here.
      const message = checkProfileNames(
        { ...profile.definition, mcpServers: [] },
        { tools: capabilities.tools, mcpServers: [] },
      );
      if (message !== undefined) {
        unresolved.push(profile.name);
        log("profile-unresolved", { profile: profile.name, message });
      }
    }
    return unresolved;
  } catch (error) {
    log("capabilities-publish-failed", { message: errorMessage(error) });
    return [];
  }
}

/**
 * The profile snapshots of the sessions that still have a conversation, by conversation id, for `Host.open` to
 * recompute their tool filters before runs resume. An unreadable database or snapshot is skipped and logged: the
 * filters are also recomputed at each input.
 */
export async function liveConversationProfiles(
  pool: pg.Pool,
): Promise<Map<number, ProfileDefinition>> {
  const found = new Map<number, ProfileDefinition>();
  try {
    const { rows } = await pool.query<{ conversation_id: string; profile_snapshot: unknown }>(
      `select conversation_id, profile_snapshot from inbox.sessions
        where conversation_id is not null and profile_snapshot is not null and status <> 'deleted'`,
    );
    for (const row of rows) {
      const definition = validateProfileDefinition(row.profile_snapshot);
      if (typeof definition === "string") {
        log("profile-snapshot-invalid", { conversation: row.conversation_id, message: definition });
        continue;
      }
      found.set(Number(row.conversation_id), definition);
    }
  } catch (error) {
    log("profile-tools-reapply-skipped", { message: errorMessage(error) });
  }
  return found;
}
