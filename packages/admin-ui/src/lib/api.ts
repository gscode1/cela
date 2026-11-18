/** The part of `GET /admin/settings` the console reads in this slice (docs/session-api.md). */
export interface AdminSettings {
  defaultModel: string;
  allowlist: string[];
  reasoning: string | null;
  maxReasoning: string | null;
  defaultProfile: string | null;
  turnBudget: number;
  /** Null: no token limit. Absent from an API that predates it. */
  tokenBudget?: number | null;
  /** Goes back as `expectedRevision` on the next write (docs/decisions/0023-admin-revisions.md). */
  revision: number;
  updatedAt: string;
  updatedBy: string;
}

/** A non-2xx answer. `message` is the API's own error text, to be shown as text only. */
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function errorText(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json();
    if (typeof body === "object" && body !== null && "error" in body) {
      const { error } = body;
      if (typeof error === "string") return error;
    }
  } catch {
    // Not JSON: fall through to the status line.
  }
  return `HTTP ${String(res.status)}`;
}

/**
 * One call to the admin API of the same origin. The token goes in the `Authorization` header and nowhere else: it is
 * not stored, logged or put in a URL.
 */
export async function adminFetch<T>(
  token: string,
  path: string,
  init: Omit<RequestInit, "headers"> = {},
): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "omit",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
  });
  if (!res.ok) throw new ApiError(res.status, await errorText(res));
  return (await res.json()) as T;
}

export function getSettings(token: string, signal?: AbortSignal): Promise<AdminSettings> {
  return adminFetch<AdminSettings>(token, "/admin/settings", signal ? { signal } : {});
}

/** A write with a JSON body (`PUT`); the caller puts `expectedRevision` in it. */
export function adminPut<T>(token: string, path: string, body: unknown): Promise<T> {
  return adminFetch<T>(token, path, { method: "PUT", body: JSON.stringify(body) });
}

/** True for the `409` of a write the stored state refuses (a stale revision, or disabling the default profile). */
export function isConflict(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 409;
}

/** What the sign-in screen says for a failed check; both are about the token, not the network. */
export function signInMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "invalid token";
    if (error.status === 403) return "valid owner without admin access";
    return `sign-in failed: ${error.message}`;
  }
  return "could not reach the server";
}
