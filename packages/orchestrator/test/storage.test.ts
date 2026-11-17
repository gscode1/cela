import type { Storage } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.ts";
import { openStorageWhenFree } from "../src/storage.ts";

const config = loadConfig({
  PI_ORCH_NAMESPACE: "test-ns",
  PI_ORCH_WARMPOOL: "test-pool",
  PI_ONECLI_GATEWAY: "http://gateway:10255",
  PI_ONECLI_API: "http://gateway-api:10256",
  PI_DURABLE_DATABASE_URL: "postgres://u:p@db:5432/app",
  PI_API_TOKENS: "alice:0123456789abcdef0123",
  PI_DURABLE_SCHEMA: "pi_missing",
});
const LOCK_ERROR = "Storage is in use or its schema does not exist; only one owner is supported";
const storage = {} as Storage;

/** Runs the loop until it opens, and returns the event names it logged. */
async function run(schemaPresent: boolean): Promise<string[]> {
  const lines: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  });
  let attempts = 0;
  await openStorageWhenFree(config, new AbortController().signal, 1, {
    open: () => {
      attempts += 1;
      return attempts === 1 ? Promise.reject(new Error(LOCK_ERROR)) : Promise.resolve(storage);
    },
    schemaExists: () => Promise.resolve(schemaPresent),
    ensureSchema: () => Promise.resolve(),
  });
  return lines.map((line) => (JSON.parse(line) as { event: string }).event);
}

describe("openStorageWhenFree", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reports a missing schema as such, not as a held lock", async () => {
    expect(await run(false)).toEqual(["storage-schema-missing"]);
  }, 5_000);

  it("still reports a held lock when the schema exists", async () => {
    expect(await run(true)).toEqual(["waiting-for-lock"]);
  }, 5_000);

  it("creates the schema once, before the first open, and not again on a retry", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const order: string[] = [];
    await openStorageWhenFree(config, new AbortController().signal, 1, {
      ensureSchema: () => {
        order.push("ensure");
        return Promise.resolve();
      },
      open: () => {
        order.push("open");
        return order.length === 2
          ? Promise.reject(new Error(LOCK_ERROR))
          : Promise.resolve(storage);
      },
      schemaExists: () => Promise.resolve(true),
    });
    expect(order).toEqual(["ensure", "open", "open"]);
  }, 5_000);
});
