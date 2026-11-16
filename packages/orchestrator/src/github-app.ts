import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Redacted } from "./onecli.js";

/** Where the GitHub App secret is mounted (ExternalSecret `pi-github-app`): `app-id`, `installation-id`, `private-key.pem`. */
export const GITHUB_APP_DIR = "/etc/pi-github-app";

export interface GithubApp {
  appId: string;
  installationId: string;
  privateKey: Redacted;
}

/** What a session's token may do: push code and open pull requests on one repository, nothing else. */
export const TOKEN_PERMISSIONS = {
  contents: "write",
  pull_requests: "write",
  metadata: "read",
} as const;

export interface InstallationToken {
  token: Redacted;
  expiresAt: Date;
}

export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    /** Set by callers that bound the call (OneCLI admin); a real fetch honours it. */
    signal?: AbortSignal;
  },
) => Promise<{
  status: number;
  /** Optional: a real fetch Response has it. Read only to tell GitHub's rate limiting from a refusal. */
  headers?: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

const b64url = (value: Buffer | string): string => Buffer.from(value).toString("base64url");

/**
 * An RS256 JWT for the GitHub App: `iss` is the App id, issued 60 s in the past to absorb clock skew and valid for
 * 9 minutes (GitHub allows at most 10). It only authenticates the call that mints an installation token.
 */
export function signAppJwt(app: GithubApp, nowMs: number): string {
  const now = Math.floor(nowMs / 1000);
  const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(
    JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: app.appId }),
  )}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(app.privateKey.reveal());
  return `${unsigned}.${b64url(signature)}`;
}

/** Reads the mounted App secret. Read at every mint, so a rotated key needs no restart. Never logged. */
export async function loadGithubApp(dir: string): Promise<GithubApp> {
  const names = ["app-id", "installation-id", "private-key.pem"] as const;
  // allSettled, not all: the error must name every missing file in a fixed order, not whichever read failed first.
  const results = await Promise.allSettled(
    names.map(async (name) => (await readFile(join(dir, name), "utf8")).trim()),
  );
  const missing = names.filter((_, i) => results[i]?.status === "rejected");
  if (missing.length > 0) {
    const verb = missing.length === 1 ? "is" : "are";
    throw new Error(
      `GitHub App secret is not available: ${missing.join(", ")} ${verb} missing in ${dir}`,
    );
  }
  const [appId = "", installationId = "", privateKey = ""] = results.map((r) =>
    r.status === "fulfilled" ? r.value : "",
  );
  if (!/^\d+$/.test(appId) || !/^\d+$/.test(installationId)) {
    throw new Error("GitHub App app-id and installation-id must be numeric");
  }
  return { appId, installationId, privateKey: new Redacted(privateKey) };
}

/** A GitHub answer that no retry will fix: the repository is not in the installation, or the App lacks a permission. */
export class GithubDeniedError extends Error {}

/**
 * Mints a one-hour installation token limited to one repository by GitHub itself (`repositories: [name]`) and to
 * `TOKEN_PERMISSIONS`. OneCLI v2 cannot scope by repository, so this is the only scope boundary. The answer is
 * checked: the token must name exactly the requested repository, or it is thrown away.
 */
export async function mintInstallationToken(
  app: GithubApp,
  repo: string,
  fetchImpl: FetchLike,
  nowMs: number,
  apiBase = "https://api.github.com",
): Promise<InstallationToken> {
  const name = repo.split("/")[1] ?? "";
  const response = await fetchImpl(
    `${apiBase}/app/installations/${encodeURIComponent(app.installationId)}/access_tokens`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${signAppJwt(app, nowMs)}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "pi-durable-k8s",
        "content-type": "application/json",
      },
      body: JSON.stringify({ repositories: [name], permissions: TOKEN_PERMISSIONS }),
    },
  );
  if (response.status !== 201) {
    // The body of an error is GitHub's message, never a secret; the request carried none that it would echo.
    const detail = (await response.text().catch(() => "")).slice(0, 200);
    const message = `GitHub refused the installation token for ${repo}: HTTP ${String(response.status)} ${detail}`;
    // GitHub answers its primary and secondary rate limits with 403 (or 429). That is a wait, not a refusal: failing the
    // session for good over it would lose every session that mints while the limit lasts (the 50-session load).
    const rateLimited =
      response.status === 429 ||
      (response.status === 403 &&
        (response.headers?.get("x-ratelimit-remaining") === "0" ||
          response.headers?.get("retry-after") != null ||
          /rate limit|abuse detection/i.test(detail)));
    if (rateLimited) throw new Error(message);
    if (
      response.status === 401 ||
      response.status === 403 ||
      response.status === 404 ||
      response.status === 422
    ) {
      throw new GithubDeniedError(message);
    }
    throw new Error(message);
  }
  const body = (await response.json()) as {
    token?: unknown;
    expires_at?: unknown;
    repository_selection?: unknown;
    repositories?: { full_name?: unknown }[];
  };
  if (typeof body.token !== "string" || typeof body.expires_at !== "string") {
    throw new Error("GitHub answered without a token");
  }
  const granted = (body.repositories ?? []).map((entry) => String(entry.full_name).toLowerCase());
  if (granted.length !== 1 || granted[0] !== repo.toLowerCase()) {
    // A token wider than asked, or for another owner's same-named repository: never hand it to a session.
    throw new GithubDeniedError(
      `GitHub token for ${repo} does not cover exactly that repository (${String(granted.length)} repositories granted)`,
    );
  }
  return { token: new Redacted(body.token), expiresAt: new Date(body.expires_at) };
}
