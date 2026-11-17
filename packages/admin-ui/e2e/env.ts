/** What the browser suite needs from the environment; see docs/e2e.md ("console" suite). */
export function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
}

/** An owner with admin access, a valid owner without it, and a token ingest does not know. */
export function tokens(): { admin: string; nonAdmin: string; unknown: string } {
  return {
    admin: required("CONSOLE_ADMIN_TOKEN"),
    nonAdmin: required("CONSOLE_NONADMIN_TOKEN"),
    unknown: process.env.CONSOLE_UNKNOWN_TOKEN ?? "0".repeat(64),
  };
}
