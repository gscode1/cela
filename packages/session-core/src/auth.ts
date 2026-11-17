import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

/** Who is calling. `owner` is recorded on every session and checked on every call. */
export interface Principal {
  /** Display name of the token entry. */
  owner: string;
  /**
   * Stable identity of the caller, stored on every session and compared on every call. For a static token it is
   * `static:<owner>`; an OIDC verifier returns the token's `iss` + `sub` here.
   */
  subject: string;
}

/**
 * The single seam for authentication. Ingest and the orchestrator call this and nothing else, so an OIDC
 * verifier replaces `tokenAuthenticator` without touching a route. Resolves to undefined for "not authenticated".
 */
export type Authenticator = (headers: IncomingHttpHeaders) => Promise<Principal | undefined>;

const OWNER = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const MIN_TOKEN_LENGTH = 16;

const digest = (value: string): Buffer => createHash("sha256").update(value).digest();

/**
 * Static bearer tokens from a Kubernetes Secret, one `owner:token` entry per line (or comma). Every
 * candidate is compared in constant time, so the answer does not depend on which entry matched.
 * Error messages never contain a token.
 */
export function tokenAuthenticator(spec: string): Authenticator {
  const entries = spec
    .split(/[\n,]/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line, index) => {
      const at = line.indexOf(":");
      const owner = at < 0 ? "" : line.slice(0, at);
      const token = at < 0 ? "" : line.slice(at + 1);
      // The bearer header is parsed as `Bearer +(\S+)`, so a token with whitespace (`alice: abc...`) could
      // never be presented back: refuse it at load instead of leaving that owner locked out silently.
      if (!OWNER.test(owner) || token.length < MIN_TOKEN_LENGTH || /\s/.test(token)) {
        throw new Error(
          `API token entry ${String(index + 1)} must be owner:token (token at least ${String(MIN_TOKEN_LENGTH)} characters, no whitespace)`,
        );
      }
      return { owner, hash: digest(token) };
    });
  if (entries.length === 0) throw new Error("no API tokens configured");
  // The match loop below keeps the last hit, so a token shared by two owners would silently authenticate as one of
  // them. Refuse it at load; the message names the owners, never the token.
  const ownerOfHash = new Map<string, string>();
  for (const entry of entries) {
    const key = entry.hash.toString("hex");
    const first = ownerOfHash.get(key);
    if (first !== undefined && first !== entry.owner) {
      throw new Error(
        `API tokens of owners ${first} and ${entry.owner} are identical; every token must be unique`,
      );
    }
    ownerOfHash.set(key, entry.owner);
  }

  return (headers) => {
    const header = headers.authorization;
    const match = typeof header === "string" ? /^Bearer +(\S+)$/i.exec(header) : null;
    const presented = digest(match?.[1] ?? "");
    let found: string | undefined;
    for (const entry of entries) {
      if (timingSafeEqual(entry.hash, presented) && match !== null) found = entry.owner;
    }
    return Promise.resolve(
      found === undefined ? undefined : { owner: found, subject: `static:${found}` },
    );
  };
}

/**
 * `PI_API_ADMINS`: comma- or newline-separated owner names (not secrets) that may call `/admin/*`. Empty or unset
 * means nobody: the admin API answers 403 to everyone.
 */
export function parseAdmins(spec: string | undefined): string[] {
  const names = (spec ?? "")
    .split(/[\n,]/)
    .map((name) => name.trim())
    .filter((name) => name !== "");
  for (const name of names) {
    if (!OWNER.test(name)) throw new Error("PI_API_ADMINS entries must be owner names");
  }
  return names;
}

export const isAdmin = (principal: Principal, admins: readonly string[]): boolean =>
  admins.includes(principal.owner);
