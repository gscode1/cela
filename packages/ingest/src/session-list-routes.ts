import type { ServerResponse } from "node:http";
import type pg from "pg";
import {
  LEGACY_PROFILE,
  listSessions,
  parseSessionCursor,
  sendJson,
  SESSION_LIST_DEFAULT,
  SESSION_LIST_MAX,
  SESSION_STATUSES,
} from "@cela/session-core";
import type { ModelChoice, SessionListQuery, SessionStatus } from "@cela/session-core";

/**
 * `GET /sessions?status=&limit=&cursor=` (the caller's own sessions) and `GET /admin/sessions?owner=&...` (every
 * owner's; the caller checked the admin right). Metadata only: the list never reads a transcript or an event.
 */
export async function getSessionList(
  res: ServerResponse,
  pool: pg.Pool,
  defaultModel: () => ModelChoice,
  url: URL,
  scope: { ownerSubject: string } | { admin: true },
): Promise<void> {
  const query = parseQuery(url, "admin" in scope);
  if (typeof query === "string") {
    sendJson(res, 400, { error: query });
    return;
  }
  const page = await listSessions(pool, {
    ...query,
    ...("ownerSubject" in scope ? { ownerSubject: scope.ownerSubject } : { withOwner: true }),
  });
  // Sessions from before profiles and before stored models run the legacy profile and the default model.
  let fallback: ModelChoice | undefined;
  sendJson(res, 200, {
    sessions: page.sessions.map(({ repo, profile, model, ...rest }) => ({
      ...rest,
      profile: profile ?? LEGACY_PROFILE,
      model: model ?? (fallback ??= defaultModel()),
      ...(repo === null ? {} : { repo }),
    })),
    ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
  });
}

function parseQuery(url: URL, admin: boolean): Omit<SessionListQuery, "ownerSubject"> | string {
  const status = url.searchParams.get("status");
  if (status !== null && !SESSION_STATUSES.includes(status as SessionStatus)) {
    return `status must be one of ${SESSION_STATUSES.join(", ")}`;
  }
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? SESSION_LIST_DEFAULT : limitOf(rawLimit);
  if (limit === undefined) return `limit must be an integer from 1 to ${String(SESSION_LIST_MAX)}`;
  const rawCursor = url.searchParams.get("cursor");
  const cursor = rawCursor === null ? undefined : parseSessionCursor(rawCursor);
  if (rawCursor !== null && cursor === undefined) return "cursor must be one this API returned";
  const owner = url.searchParams.get("owner");
  if (owner !== null && (!admin || owner === "" || owner.length > 200)) {
    return admin
      ? "owner must be 1 to 200 characters"
      : "owner is only accepted by /admin/sessions";
  }
  return {
    limit,
    ...(status === null ? {} : { status: status as SessionStatus }),
    ...(cursor === undefined ? {} : { cursor }),
    ...(owner === null ? {} : { owner }),
  };
}

function limitOf(raw: string): number | undefined {
  if (!/^[0-9]{1,4}$/.test(raw)) return undefined;
  const limit = Number(raw);
  return limit >= 1 && limit <= SESSION_LIST_MAX ? limit : undefined;
}
