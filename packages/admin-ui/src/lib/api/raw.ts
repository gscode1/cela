import { apiErrorOf } from "@/lib/api";

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
  if (!res.ok) throw await apiErrorOf(res);
  return res;
}

export async function adminJson<T>(
  token: string,
  path: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  return (await (await adminRequest(token, path, init)).json()) as T;
}
