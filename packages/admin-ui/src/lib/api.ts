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
/** What keeps a delete from happening, as the API names it in a 409 (docs/session-api.md, "Deleting"). */
export interface BlockedBy {
  profiles?: { name: string; version: number }[];
  sessions?: { count: number; sample: string[] };
  defaultProfile?: true;
  enabledForNew?: true;
}

export class ApiError extends Error {
  readonly status: number;
  /** Only on a refused delete. */
  readonly blockedBy: BlockedBy | undefined;
  constructor(status: number, message: string, blockedBy?: BlockedBy) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.blockedBy = blockedBy;
  }
}

/** The `ApiError` for a failed response: its `error` text (else the status line) and any `blockedBy`. */
export async function apiErrorOf(res: Response): Promise<ApiError> {
  try {
    const body: unknown = await res.json();
    if (typeof body === "object" && body !== null && "error" in body) {
      const { error } = body;
      const blockedBy =
        "blockedBy" in body && typeof body.blockedBy === "object" && body.blockedBy !== null
          ? (body.blockedBy as BlockedBy)
          : undefined;
      if (typeof error === "string") return new ApiError(res.status, error, blockedBy);
    }
  } catch {
    // Not JSON: fall through to the status line.
  }
  return new ApiError(res.status, `HTTP ${String(res.status)}`);
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
  if (!res.ok) throw await apiErrorOf(res);
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
