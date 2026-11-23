import type pg from "pg";
import { describe, expect, it } from "vitest";
import {
  isWebSocketKey,
  safeSubprotocol,
  sameSecret,
  switchingProtocols,
  websocketAccept,
} from "../src/live-view.ts";
import { newLiveViewToken, requestDelete, setLiveViewToken } from "../src/store.ts";

// The shared pieces of the public live view (issue #418, ADR 0066).

describe("live view token", () => {
  it("is 256 random bits as a URL-safe string", () => {
    const tokens = new Set(Array.from({ length: 50 }, () => newLiveViewToken()));
    expect(tokens.size).toBe(50);
    for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("is stored only on an active session, and cleared by every delete request", async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const db = {
      query: (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        return Promise.resolve({ rows: [], rowCount: 1 });
      },
    } as unknown as pg.Pool;
    await setLiveViewToken(db, "s", "t");
    expect(calls[0]?.sql).toMatch(/status = 'active' or \$2::text is null/);
    expect(calls[0]?.params).toEqual(["s", "t"]);
    await requestDelete(db, "s");
    expect(calls[1]?.sql).toMatch(/status = 'deleting', live_view_token = null/);
  });
});

describe("WebSocket helpers", () => {
  it("computes the accept value of RFC 6455", () => {
    expect(websocketAccept("dGhlIHNhbXBsZSBub25jZQ==")).toBe("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
  });

  it("accepts only a 16-byte base64 key and token-like subprotocols", () => {
    expect(isWebSocketKey("dGhlIHNhbXBsZSBub25jZQ==")).toBe(true);
    for (const bad of ["", "short", "dGhlIHNhbXBsZSBub25jZQ==\r\n", 5, undefined]) {
      expect(isWebSocketKey(bad)).toBe(false);
    }
    expect(safeSubprotocol("binary")).toBe("binary");
    expect(safeSubprotocol("binary, base64")).toBe("binary, base64");
    expect(safeSubprotocol("a\r\nx-evil: 1")).toBeUndefined();
    expect(safeSubprotocol(["binary"])).toBeUndefined();
  });

  it("builds a 101 from the accept and the chosen protocol only", () => {
    expect(switchingProtocols("abc=", "binary")).toBe(
      "HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: abc=\r\nsec-websocket-protocol: binary\r\n\r\n",
    );
    expect(switchingProtocols("abc=", undefined)).not.toContain("protocol");
  });

  it("compares secrets of different lengths without throwing", () => {
    expect(sameSecret("abc", "abc")).toBe(true);
    expect(sameSecret("abc", "abcd")).toBe(false);
    expect(sameSecret("", "a")).toBe(false);
  });
});
