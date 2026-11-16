import type pg from "pg";
import {
  checkProfileNames,
  errorMessage,
  publishCapabilities,
  readProfiles,
} from "@pi-durable-k8s/session-core";
import type { Capabilities } from "@pi-durable-k8s/session-core";
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
