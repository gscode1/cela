import type { IncomingMessage, ServerResponse } from "node:http";

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

export class BodyError extends Error {}

/** Reads a JSON object body, at most `limit` bytes. Throws BodyError for anything a client got wrong. */
export async function readJsonObject(
  req: IncomingMessage,
  limit = 128 * 1024,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > limit) throw new BodyError("body too large");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BodyError("body is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new BodyError("body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
