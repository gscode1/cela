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

/** The client did not deliver the whole body in time: answer 408, then drop the connection (see sendBodyError). */
export class BodyTimeoutError extends BodyError {
  constructor() {
    super("body not received in time");
  }
}

export const BODY_TIMEOUT_MS = 30_000;

/**
 * Reads a body as text, at most `limit` bytes and `timeoutMs` in all. The server's requestTimeout is 0 (it would
 * cut the SSE streams), so without this deadline a client could trickle a body forever. On expiry it throws
 * BodyTimeoutError and leaves the request alone: destroying it here would close the socket before the 408 is sent.
 */
export async function readBodyText(
  req: IncomingMessage,
  limit = 128 * 1024,
  timeoutMs = BODY_TIMEOUT_MS,
): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new BodyTimeoutError());
    }, timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("close", onClose);
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > limit) {
        cleanup();
        reject(new BodyError("body too large"));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onClose = (): void => {
      cleanup();
      reject(new BodyError("connection closed before the body ended"));
    };
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("close", onClose);
  });
  return Buffer.concat(chunks).toString("utf8");
}

/** Answers a body failure: 408 for a stalled body (and the request is destroyed once the answer is out), else 400. */
export function sendBodyError(res: ServerResponse, req: IncomingMessage, error: unknown): void {
  if (error instanceof BodyTimeoutError) {
    res.once("close", () => req.destroy());
    sendJson(res, 408, { error: error.message }, { connection: "close" });
    return;
  }
  sendJson(res, 400, { error: errorMessage(error) });
}

/** Reads a JSON object body, at most `limit` bytes. Throws BodyError for anything a client got wrong. */
export async function readJsonObject(
  req: IncomingMessage,
  limit = 128 * 1024,
  timeoutMs = BODY_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  const text = await readBodyText(req, limit, timeoutMs);
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
