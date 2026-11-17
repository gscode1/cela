import { ApiError } from "@/lib/api";

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
 * A call to the admin API of the same origin that keeps the `Response`, for the callers that need the status (`200`
 * against `201`) or the bytes (a zip). The token goes in the header only, as in `adminFetch`.
 */
export async function adminRequest(
  token: string,
  path: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  const request: RequestInit = { credentials: "omit", headers };
  if (init.method !== undefined) request.method = init.method;
  if (init.signal !== undefined) request.signal = init.signal;
  if (init.body !== undefined) {
    headers["content-type"] = "application/json";
    request.body = JSON.stringify(init.body);
  }
  const res = await fetch(path, request);
  if (!res.ok) throw new ApiError(res.status, await errorText(res));
  return res;
}

export async function adminJson<T>(
  token: string,
  path: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  return (await (await adminRequest(token, path, init)).json()) as T;
}
