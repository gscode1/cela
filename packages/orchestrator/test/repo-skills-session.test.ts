import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InboxEvent, ProfileDefinition, SessionRow } from "@pi-durable-k8s/session-core";
import { loadConfig } from "../src/config.ts";
import { Host } from "../src/host.ts";
import { SessionService } from "../src/sessions.ts";
import type { WorkspaceEnv } from "../src/workspace.ts";

const config = loadConfig({
  PI_DURABLE_DATABASE_URL: "postgres://u:p@db:5432/app",
  PI_API_TOKENS: "alice:0123456789abcdef0123",
});
const MODEL = { provider: "scripted", model: "scripted-1" } as const;
const ADMIN = {
  name: "pdf",
  description: "Admin PDF",
  location: `/workspace/.skills/pdf/${"a".repeat(64)}/SKILL.md`,
};

let root: string;
let calls: string[];
let open: boolean;
let instructions: Map<number, string | undefined>;
let configured: number;
let failScan: boolean;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "repo-skills-"));
  calls = [];
  open = true;
  instructions = new Map();
  configured = 0;
  failScan = false;
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

const skill = (description: string): string => `---\ndescription: ${description}\n---\nbody\n`;
async function put(path: string, text: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text);
}

/** The sandbox's /workspace/repo is the temp dir; every env call is recorded. */
function sandboxEnv(): WorkspaceEnv {
  const real = new NodeExecutionEnv({ cwd: root });
  const at = (path: string): string => path.replace("/workspace/repo", root);
  return {
    listDir: (path: string, context: never) => {
      calls.push("listDir");
      if (failScan) return Promise.reject(new Error("bridge is gone"));
      return real.listDir(at(path), context);
    },
    readTextFile: (path: string, context: never) => {
      calls.push("readTextFile");
      return real.readTextFile(at(path), context);
    },
  } as unknown as WorkspaceEnv;
}

/** A host that records what a session service asks of the sandbox; instructions behave as Pi's (equal text: no write). */
function fakeHost(): Host {
  return {
    sandboxOpen: () => open,
    workspaceEnv: () => {
      calls.push("workspaceEnv");
      return Promise.resolve(sandboxEnv());
    },
    setInstructions: (id: number, text: string | undefined) => {
      if (instructions.get(id) === text) return Promise.resolve(false);
      instructions.set(id, text);
      configured += 1;
      return Promise.resolve(true);
    },
  } as unknown as Host;
}

const session = (definition: ProfileDefinition): SessionRow => ({
  id: "s1",
  owner: "alice",
  ownerSubject: "static:alice",
  status: "active",
  conversationId: 7,
  model: MODEL,
  failure: null,
  repo: { repo: "acme/widgets" },
  onecli: null,
  workspaceReadyAt: new Date(),
  profile: { name: "coding", version: 2, snapshot: definition },
  createdAt: new Date(),
  lastActivityAt: new Date(),
});
const message: InboxEvent = {
  id: "e1",
  sessionId: "s1",
  source: "test",
  sourceEventId: "e1",
  kind: "message",
  payload: { text: "hi" },
  status: "pending",
  attempts: 0,
  createdAt: new Date(),
  submittedAt: null,
  error: null,
} as unknown as InboxEvent;

function service(host: Host = fakeHost(), admin: (typeof ADMIN)[] = [ADMIN]): SessionService {
  return new SessionService({} as pg.Pool, host, {
    testFaults: false,
    defaultModel: config.models.default,
    turnBudget: () => 100,
    repos: { prepare: () => Promise.resolve() } as never,
    skills: {
      catalogFor: () => Promise.resolve(undefined),
      entriesFor: () => Promise.resolve(admin),
    },
  });
}

const ON: ProfileDefinition = { instructions: "Be brief.", repoSkills: true };

describe("repo skills at each new message", () => {
  it("flag off: no extra sandbox call beyond the clone step, and no write", async () => {
    await put(".pi/skills/a/SKILL.md", skill("A"));
    const svc = service();
    await svc.prepare(message, session({ instructions: "Be brief." }));
    // The only workspaceEnv call is the clone step's; nothing is listed or read.
    expect(calls).toEqual(["workspaceEnv"]);
    expect(configured).toBe(0);
    svc.stop();
  });

  it("applies profile instructions + one catalog, admin skills first and winning a name collision", async () => {
    await put(".pi/skills/pdf/SKILL.md", skill("Repo PDF"));
    await put(".pi/skills/csv/SKILL.md", skill("Edit CSV"));
    const svc = service();
    await svc.prepare(message, session(ON));
    const text = instructions.get(7) ?? "";
    expect(text.startsWith("Be brief.\n\nThe following skills provide")).toBe(true);
    expect(text.match(/<available_skills>/g)).toHaveLength(1);
    expect(text).toContain("Admin PDF");
    expect(text).not.toContain("Repo PDF");
    expect(text).toContain("/workspace/repo/.pi/skills/csv/SKILL.md");
    expect(text.indexOf("Admin PDF")).toBeLessThan(text.indexOf("Edit CSV"));
    svc.stop();
  });

  it("a skill added mid-session appears at the next message while the sandbox is open; unchanged text writes nothing", async () => {
    await put(".pi/skills/csv/SKILL.md", skill("Edit CSV"));
    const svc = service();
    const snapshot = session(ON);
    await svc.prepare(message, snapshot);
    await svc.prepare(message, snapshot);
    expect(configured).toBe(1);
    await put(".agents/skills/new/SKILL.md", skill("Brand new"));
    await svc.prepare(message, snapshot);
    expect(configured).toBe(2);
    expect(instructions.get(7)).toContain("Brand new");
    svc.stop();
  });

  it("a restart rescans: a new service finds what changed while the old process was down", async () => {
    await put(".pi/skills/csv/SKILL.md", skill("Edit CSV"));
    const host = fakeHost();
    const first = service(host);
    await first.prepare(message, session(ON));
    first.stop();
    await put(".pi/skills/late/SKILL.md", skill("Added during the restart"));
    const second = service(host);
    await second.prepare(message, session(ON));
    expect(instructions.get(7)).toContain("Added during the restart");
    second.stop();
  });

  it("a chat-only turn on a suspended sandbox opens nothing: no listing, no env, no write", async () => {
    await put(".pi/skills/csv/SKILL.md", skill("Edit CSV"));
    open = false;
    const svc = service();
    await svc.prepare(message, session(ON));
    expect(calls).toEqual(["workspaceEnv"]); // the clone step's (a no-op in this process); nothing of ours
    expect(configured).toBe(0);
    svc.stop();
  });

  it("a scan failure is logged, keeps the instructions and does not throw", async () => {
    const svc = service();
    await svc.prepare(message, session(ON));
    const before = instructions.get(7);
    await put(".pi/skills/csv/SKILL.md", skill("Edit CSV"));
    failScan = true;
    await expect(svc.prepare(message, session(ON))).resolves.toBeUndefined();
    expect(instructions.get(7)).toBe(before);
    svc.stop();
  });

  it("removing every repo skill removes the catalog again", async () => {
    const svc = service(fakeHost(), []);
    await put(".pi/skills/csv/SKILL.md", skill("Edit CSV"));
    await svc.prepare(message, session({ repoSkills: true }));
    expect(instructions.get(7)).toContain("Edit CSV");
    await rm(join(root, ".pi"), { recursive: true });
    await svc.prepare(message, session({ repoSkills: true }));
    expect(instructions.get(7)).toBeUndefined();
    svc.stop();
  });

  it("is ignored for a session without a repo", async () => {
    await put(".pi/skills/csv/SKILL.md", skill("Edit CSV"));
    const svc = service();
    await svc.prepare(message, { ...session(ON), repo: null });
    expect(calls).toEqual([]);
    svc.stop();
  });
});

describe("Host.setInstructions", () => {
  let host: Host;
  beforeEach(async () => {
    host = await Host.open(
      new MemoryStorage(),
      config,
      (error) => {
        throw error;
      },
      () => Promise.resolve("session"),
    );
  });
  afterEach(async () => {
    await host.close().catch(() => undefined);
  });

  it("writes only when the text differs, and undefined clears the instructions", async () => {
    const id = await host.createConversation(MODEL, { instructions: "Be brief." });
    expect(await host.setInstructions(id, "Be brief.")).toBe(false);
    expect(await host.setInstructions(id, "Be brief.\n\ncatalog")).toBe(true);
    expect(await host.instructionsOf(id)).toBe("Be brief.\n\ncatalog");
    expect(await host.setInstructions(id, "Be brief.\n\ncatalog")).toBe(false);
    expect(await host.setInstructions(id, undefined)).toBe(true);
    expect(await host.instructionsOf(id)).toBeUndefined();
    expect(host.sandboxOpen(id)).toBe(false);
  });
});
