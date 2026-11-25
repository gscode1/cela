import type { AdminContext } from "./context.js";

/**
 * Deployment-wide reads and probes (catalog, status, history, network probe; ADR 0070). No tool yet: the file exists so
 * the PR that adds them edits only this one.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- the tools register on ctx once they exist
export function registerDeploymentTools(ctx: AdminContext): void {}
