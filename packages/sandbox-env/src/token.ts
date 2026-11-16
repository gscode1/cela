import { createHash, createHmac } from "node:crypto";

/**
 * Name of the container env var the SandboxClaim sets and the sandbox template turns into
 * `--auth-token-sha256`. The template defines no value for it, so a Pod created without the claim env
 * gets the literal `$(...)` text as its hash and nothing can authenticate to it (fails closed).
 */
export const SANDBOXD_TOKEN_SHA256_ENV = "SANDBOXD_AUTH_TOKEN_SHA256";

/**
 * The sandboxd bearer token of one sandbox: HMAC-SHA256(master, claimName) as hex. Deterministic, so the
 * orchestrator re-derives it after a restart instead of storing it. The master never leaves the orchestrator
 * (and the e2e driver); a sandbox only ever learns the sha256 of its own token, which does not reveal the
 * token and is useless against any other sandbox.
 */
export function deriveSandboxToken(master: string, claimName: string): string {
  if (master === "") throw new Error("sandbox master key is empty");
  return createHmac("sha256", master).update(claimName).digest("hex");
}

/** What sandboxd's `--auth-token-sha256` expects: lowercase hex of sha256 over the token's UTF-8 bytes. */
export function sandboxTokenSha256(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
