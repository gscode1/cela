import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, sep } from "node:path";

/** The console is served under this prefix; the build's Vite `base` must match it. */
export const CONSOLE_PREFIX = "/console";

/**
 * Whether the console's skills and MCP screens offer writes (`manage`) or only browsing (`readOnly`). This gates the UI
 * only: the admin API accepts writes from any admin either way (docs/admin-ui-plan.md, "Later: a catalog repository").
 */
export type ConsoleCatalogs = "manage" | "readOnly";

/** Reads `PI_CONSOLE_CATALOGS`: unset or blank is `manage`; anything but the two names is a startup error. */
export function parseConsoleCatalogs(value: string | undefined): ConsoleCatalogs {
  const text = value?.trim() ?? "";
  if (text === "" || text === "manage") return "manage";
  if (text === "readOnly") return "readOnly";
  throw new Error('PI_CONSOLE_CATALOGS must be "manage" or "readOnly"');
}

const CONFIG_PATH = `${CONSOLE_PREFIX}/config.json`;

export const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/**
 * Headers for everything a browser renders from ingest: the console and `/admin/*`. The policy has no inline
 * allowance, so a script smuggled into API content cannot run, and nothing may frame the page.
 */
export function setConsoleHeaders(res: ServerResponse): void {
  res.setHeader("cache-control", "no-store");
  res.setHeader("content-security-policy", "default-src 'self'; frame-ancestors 'none'");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
}

export function isConsolePath(pathname: string): boolean {
  return pathname === CONSOLE_PREFIX || pathname.startsWith(`${CONSOLE_PREFIX}/`);
}

function plain(
  res: ServerResponse,
  status: number,
  text: string,
  extra: Record<string, string> = {},
): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", ...extra });
  res.end(text);
}

/** The file below `root` that `relative` names, or undefined: a `..` segment, a NUL or a backslash is never served. */
export async function fileFor(root: string, relative: string): Promise<string | undefined> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(relative);
  } catch {
    return undefined;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return undefined;
  if (decoded.split("/").some((segment) => segment === "..")) return undefined;
  const path = join(root, decoded);
  if (path !== root && !path.startsWith(root + sep)) return undefined;
  try {
    return (await stat(path)).isFile() ? path : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Serves `/console` and `/console/*` before the bearer gate: the page holds no secret, the token goes only to `/admin/*`
 * from the browser. Only GET and HEAD. A path with a file extension is an asset and is a 404 when missing; any
 * other path is a client-side route and gets `index.html`. With no `consoleDir` every console path is a 404.
 */
export async function serveConsole(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  consoleDir: string | undefined,
  catalogs: ConsoleCatalogs = "manage",
): Promise<void> {
  setConsoleHeaders(res);
  if (req.method !== "GET" && req.method !== "HEAD") {
    plain(res, 405, "method not allowed", { allow: "GET, HEAD" });
    return;
  }
  if (consoleDir === undefined) {
    plain(res, 404, "not found");
    return;
  }
  // The page's one runtime setting, answered here (so before the bearer gate) and never from a file. It holds no secret.
  if (pathname === CONFIG_PATH) {
    const body = JSON.stringify({ catalogs });
    res.writeHead(200, {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body)),
    });
    res.end(req.method === "HEAD" ? undefined : body);
    return;
  }
  // `/console` has no trailing slash: relative asset URLs would resolve against `/`.
  if (pathname === CONSOLE_PREFIX) {
    res.writeHead(308, { location: `${CONSOLE_PREFIX}/` });
    res.end();
    return;
  }
  const relative = pathname.slice(CONSOLE_PREFIX.length + 1);
  const isAsset = extname(relative) !== "";
  const file = await fileFor(consoleDir, isAsset ? relative : "index.html");
  if (file === undefined) {
    plain(res, 404, "not found");
    return;
  }
  const size = (await stat(file)).size;
  res.writeHead(200, {
    "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
    "content-length": String(size),
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(file)
    .on("error", () => res.destroy())
    .pipe(res);
}
