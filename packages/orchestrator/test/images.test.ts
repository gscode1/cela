import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sandboxEnv = vi.hoisted(() => ({ connectSandboxEnv: vi.fn(), ensureClaim: vi.fn() }));
const kube = vi.hoisted(() => ({
  deleteClaimAndPvc: vi.fn(),
  ensureLabeledClaim: vi.fn(),
  listSandboxes: vi.fn(),
  recyclePod: vi.fn(),
  resumeIfSuspended: vi.fn(),
  suspendSandbox: vi.fn(),
}));
vi.mock("../src/kube.ts", () => kube);
vi.mock("@cela/sandbox-env", () => ({
  ENV: { masterKey: "PI_SANDBOX_MASTER_KEY" },
  SANDBOXD_TOKEN_SHA256_ENV: "SANDBOXD_AUTH_TOKEN_SHA256",
  deriveSandboxToken: () => "token",
  sandboxTokenSha256: () => "hash",
  ...sandboxEnv,
}));

import { loadConfig } from "../src/config.ts";
import { Host } from "../src/host.ts";
import type { McpServerSpec } from "../src/mcp.ts";
import { lazyImageProcessor } from "../src/images.ts";
import { FakeMcp } from "./fake-mcp.ts";

const config = loadConfig({
  PI_ORCH_NAMESPACE: "test-ns",
  PI_ORCH_WARMPOOL: "test-pool",
  PI_ONECLI_GATEWAY: "http://gateway:10255",
  PI_ONECLI_API: "http://gateway-api:10256",
  PI_DURABLE_DATABASE_URL: "postgres://u:p@db:5432/app",
  PI_API_TOKENS: "alice:0123456789abcdef0123",
});
const MODEL = { provider: "scripted", model: "scripted-1" } as const;
const SPEC: McpServerSpec = {
  name: "demo",
  url: "https://mcp.example.com/mcp",
  transport: "streamable-http",
  enabled: true,
  readOnly: true,
  timeoutMs: 5_000,
  maxOutputBytes: 24_576,
  onecliSecret: null,
};
const SHOT = {
  name: "shot",
  description: "A screenshot",
  inputSchema: { type: "object", properties: {} },
};
/** The default limits of a model that declares none (Pi's `DEFAULT_IMAGE_LIMITS`). */
const MAX_SIDE = 2000;
const MAX_BYTES = 4.5 * 1024 * 1024;

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = (crcTable[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type), data]);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}
/** A valid RGB PNG with a gradient, `size` pixels square. */
function png(size: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.alloc(1 + size * 3);
  const raw = Buffer.alloc(row.length * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      raw[y * row.length + 1 + x * 3] = x % 256;
      raw[y * row.length + 2 + x * 3] = y % 256;
      raw[y * row.length + 3 + x * 3] = (x + y) % 256;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
/** The PNG signature and a header, then bytes no decoder takes. */
const CORRUPT = Buffer.concat([png(8).subarray(0, 33), Buffer.from("not an image at all")]);

function dimensions(data: string): { width: number; height: number } | undefined {
  const bytes = Buffer.from(data, "base64");
  if (bytes.subarray(1, 4).toString() === "PNG") {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  // JPEG: the first start-of-frame marker.
  for (let i = 2; i + 9 < bytes.length;) {
    if (bytes[i] !== 0xff) return undefined;
    const marker = bytes[i + 1] ?? 0;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
    }
    i += 2 + bytes.readUInt16BE(i + 2);
  }
  return undefined;
}

/** What the storage holds of one kind: every JSON object in the storage files for which `pick` returns a value. */
async function stored<T>(dir: string, pick: (value: object) => T | undefined): Promise<T[]> {
  const found: T[] = [];
  const walk = (value: unknown) => {
    if (typeof value !== "object" || value === null) return;
    const hit = pick(value);
    if (hit !== undefined) found.push(hit);
    for (const child of Object.values(value)) walk(child);
  };
  for (const name of await readdir(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    for (const line of (await readFile(join(dir, name), "utf8")).split("\n")) {
      if (line.trim() !== "") walk(JSON.parse(line));
    }
  }
  return found;
}
const imagesIn = (dir: string) =>
  stored(dir, (v) =>
    "type" in v && v.type === "image" && "data" in v && typeof v.data === "string"
      ? { data: v.data, mimeType: String((v as { mimeType?: unknown }).mimeType) }
      : undefined,
  );

const dirs: string[] = [];
const hosts: Host[] = [];
async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cela-images-"));
  dirs.push(dir);
  return dir;
}
beforeEach(() => {
  process.env.PI_SANDBOX_MASTER_KEY = "master";
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  for (const fn of [...Object.values(kube), ...Object.values(sandboxEnv)]) fn.mockReset();
  kube.ensureLabeledClaim.mockResolvedValue(undefined);
  kube.resumeIfSuspended.mockResolvedValue(false);
  sandboxEnv.ensureClaim.mockResolvedValue(undefined);
});
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close().catch(() => undefined);
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 600; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function openHost(dir: string, fake: FakeMcp): Promise<Host> {
  const catalog = {
    get: (): readonly McpServerSpec[] => [SPEC],
    subscribe: () => () => undefined,
  };
  const host = await Host.open(
    await openNodeJsonlStorage(dir, context),
    config,
    (error) => {
      throw error;
    },
    () => Promise.resolve("session"),
    {},
    [],
    { catalog, mcpTransport: fake.transport },
  );
  hosts.push(host);
  return host;
}

async function run(host: Host, id: number, steps: object[], requestId: string) {
  await host.submitInput(id, {
    text: JSON.stringify({ steps, final: "finished" }),
    requestId,
    steer: false,
  });
  expect(await host.settlement(id, requestId)).toEqual({ status: "done" });
  return (await host.status(id))?.results ?? [];
}

function fakeWith(image: Buffer): FakeMcp {
  const fake = new FakeMcp();
  fake.tools = [SHOT];
  fake.onCall = () =>
    Promise.resolve({
      content: [
        { type: "text", text: "page" },
        { type: "image", data: image.toString("base64"), mimeType: "image/png" },
      ],
    });
  return fake;
}

const SHOT_STEPS = [
  { tool: "tool_search", args: { query: "screenshot" } },
  { tool: "mcp__demo__shot", args: {} },
];

describe("fit-images (docs/decisions/0055-fit-images.md)", () => {
  it("fits an oversized image from an MCP tool to the model's limits before it is stored", async () => {
    const dir = await tmp();
    const host = await openHost(dir, fakeWith(png(2600)));
    const id = await host.createConversation(MODEL, { mcpServers: ["demo"] });
    await until(async () => (await host.toolsOf(id)).deferred.includes("mcp__demo__shot"), "tools");
    const results = await run(host, id, SHOT_STEPS, "r1");
    expect(results.at(-1), JSON.stringify(results)).toMatchObject({ isError: false });
    await host.close();

    const images = await imagesIn(dir);
    expect(images.length).toBeGreaterThan(0);
    for (const image of images) {
      const size = dimensions(image.data);
      expect(size).toBeDefined();
      expect(size?.width).toBeLessThanOrEqual(MAX_SIDE);
      expect(size?.height).toBeLessThanOrEqual(MAX_SIDE);
      expect(image.data.length).toBeLessThanOrEqual(MAX_BYTES);
    }
    // The model is told what changed.
    const notes = await stored(dir, (v) =>
      "code" in v && v.code === "image" && "message" in v ? String(v.message) : undefined,
    );
    expect(notes.join(" ")).toMatch(/2600x2600/);
  }, 60_000);

  it("leaves out an image that cannot be prepared, with a note, and the run does not fail", async () => {
    const dir = await tmp();
    const host = await openHost(dir, fakeWith(CORRUPT));
    const id = await host.createConversation(MODEL, { mcpServers: ["demo"] });
    await until(async () => (await host.toolsOf(id)).deferred.includes("mcp__demo__shot"), "tools");
    const results = await run(host, id, SHOT_STEPS, "r1");
    expect(results.at(-1), JSON.stringify(results)).toMatchObject({ isError: false });
    expect((await host.status(id))?.answer).toBe("finished");
    await host.close();
    expect(await imagesIn(dir)).toEqual([]);
    const notes = await stored(dir, (v) =>
      "code" in v && v.code === "image" && "message" in v ? String(v.message) : undefined,
    );
    expect(notes.join(" ")).toMatch(/cannot be prepared for the model and was left out/);
  }, 60_000);

  it("fits the image `read` returns", async () => {
    const dir = await tmp();
    const work = await tmp();
    const file = join(work, "big.png");
    await writeFile(file, png(2600));
    sandboxEnv.connectSandboxEnv.mockImplementation(() => ({
      env: new NodeExecutionEnv({ cwd: work }),
      close: () => undefined,
    }));
    const host = await openHost(dir, new FakeMcp());
    const id = await host.createConversation(MODEL);
    const results = await run(host, id, [{ tool: "read", args: { path: file } }], "r1");
    expect(results.at(-1), JSON.stringify(results)).toMatchObject({ isError: false });
    await host.close();
    const images = await imagesIn(dir);
    expect(images.length).toBeGreaterThan(0);
    for (const image of images) {
      expect(dimensions(image.data)?.width).toBeLessThanOrEqual(MAX_SIDE);
      expect(image.data.length).toBeLessThanOrEqual(MAX_BYTES);
    }
  }, 60_000);

  it("reaches a conversation stored before the extension existed, after a restart, without editing what it stored", async () => {
    const dir = await tmp();
    const fake = fakeWith(png(2600));
    const first = await openHost(dir, fake);
    const id = await first.createConversation(MODEL, { mcpServers: ["demo"] });
    await first.close();
    // What the conversation stored names the extensions it adds, never `fit-images`: the host's pinned default has it, as
    // for every conversation created before this change.
    const stored1 = await stored(dir, (v) =>
      "add" in v && Array.isArray(v.add) ? (v.add as string[]) : undefined,
    );
    expect(stored1.flat()).toEqual(expect.arrayContaining(["tool-search", "mcp-demo"]));
    expect(stored1.flat()).not.toContain("fit-images");

    const second = await openHost(dir, fake);
    await until(
      async () => (await second.toolsOf(id)).deferred.includes("mcp__demo__shot"),
      "tools",
    );
    await run(second, id, SHOT_STEPS, "r1");
    await second.close();
    for (const image of await imagesIn(dir)) {
      expect(dimensions(image.data)?.width).toBeLessThanOrEqual(MAX_SIDE);
    }
    expect((await imagesIn(dir)).length).toBeGreaterThan(0);
  }, 60_000);

  it("lists the extension in the capabilities and keeps a profile allow-list: disallowed tools stay hidden", async () => {
    const dir = await tmp();
    const host = await openHost(dir, new FakeMcp());
    expect(host.capabilities().extensions).toContain("fit-images");
    expect(host.capabilities().tools).not.toContain("fit-images");
    const id = await host.createConversation(MODEL, { tools: ["read"], mcpServers: ["demo"] });
    const { offered } = await host.toolsOf(id);
    expect(offered).toContain("read");
    expect(offered).toContain("tool_search");
    for (const hidden of ["bash", "write", "edit"]) expect(offered).not.toContain(hidden);
  });
});

describe("lazyImageProcessor", () => {
  it("loads at the first image, once, and tries again after a failed load", async () => {
    let loads = 0;
    const processor = lazyImageProcessor(() => {
      loads += 1;
      return loads === 1
        ? Promise.reject(new Error("no wasm"))
        : Promise.resolve({ prepare: () => Promise.resolve(undefined) });
    });
    expect(loads).toBe(0);
    const limits = { maxWidth: 1, maxHeight: 1, maxBytes: 1 };
    await expect(processor.prepare(new Uint8Array(1), "image/png", limits)).rejects.toThrow(
      "no wasm",
    );
    await processor.prepare(new Uint8Array(1), "image/png", limits);
    await processor.prepare(new Uint8Array(1), "image/png", limits);
    expect(loads).toBe(2);
  });
});
