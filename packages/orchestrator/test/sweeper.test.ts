import { describe, expect, it } from "vitest";
import { OrphanSweeper } from "../src/sweeper.ts";
import type { SweeperDeps } from "../src/sweeper.ts";

const NOW = Date.parse("2026-11-16T12:00:00Z");
const OLD = new Date(NOW - 3_600_000);
const UNKNOWN = "33333333-3333-4333-8333-333333333333";

function deps(overrides: Partial<SweeperDeps> = {}) {
  const calls: string[] = [];
  const value: SweeperDeps = {
    listSessions: () => Promise.resolve([]),
    listClaims: () =>
      Promise.resolve([
        { name: "pi-conv-1", sessionLabel: UNKNOWN, createdAt: OLD },
        { name: "pi-conv-2", sessionLabel: UNKNOWN, createdAt: OLD },
        { name: "e2e-phase1", sessionLabel: undefined, createdAt: OLD },
      ]),
    listPvcs: () => Promise.resolve([{ name: "workspace-pi-conv-9", createdAt: OLD }]),
    listOneCli: () =>
      Promise.resolve({
        agents: [{ id: "a1", identifier: `pi-session-${UNKNOWN}` }],
        secrets: [],
      }),
    destroyClaim: (claim, label) => {
      calls.push(`destroy ${claim} ${label}`);
      return Promise.resolve();
    },
    revokeSession: (id) => {
      calls.push(`revoke ${id}`);
      return Promise.resolve();
    },
    graceMs: 600_000,
    maxActions: 10,
    now: () => NOW,
    ...overrides,
  };
  return { value, calls };
}

describe("OrphanSweeper", () => {
  it("removes orphans through the session-delete teardown and the OneCLI revoke, leaving the unlabelled claim", async () => {
    const { value, calls } = deps();
    const done = await new OrphanSweeper(value).run();
    expect(calls).toEqual([
      `destroy pi-conv-1 ${UNKNOWN}`,
      `destroy pi-conv-2 ${UNKNOWN}`,
      "destroy pi-conv-9 orphan-pvc-sweep",
      `revoke ${UNKNOWN}`,
    ]);
    expect(done).toHaveLength(4);
  });

  it("goes on after a failing action and reports only what succeeded", async () => {
    const { value, calls } = deps({
      destroyClaim: (claim) => {
        calls.push(`destroy ${claim}`);
        return claim === "pi-conv-1" ? Promise.reject(new Error("boom")) : Promise.resolve();
      },
    });
    const done = await new OrphanSweeper(value).run();
    expect(calls).toContain("destroy pi-conv-2");
    expect(done.map((a) => a.kind)).toEqual(["delete-claim", "delete-pvc", "revoke-agent"]);
  });

  it("does not judge agents without OneCLI, and never throws when a listing fails", async () => {
    const without = deps({ listOneCli: undefined });
    await new OrphanSweeper(without.value).run();
    expect(without.calls.some((c) => c.startsWith("revoke"))).toBe(false);

    const broken = deps({
      listPvcs: () => Promise.reject(new Error("api down")),
      listOneCli: undefined,
    });
    expect(await new OrphanSweeper(broken.value).run()).toEqual([]);
    expect(broken.calls).toEqual([]);
  });

  it("a OneCLI listing failure does not block the Kubernetes cleanup, and the other way round", async () => {
    const oneCliDown = deps({ listOneCli: () => Promise.reject(new Error("onecli down")) });
    await new OrphanSweeper(oneCliDown.value).run();
    expect(oneCliDown.calls).toEqual([
      `destroy pi-conv-1 ${UNKNOWN}`,
      `destroy pi-conv-2 ${UNKNOWN}`,
      "destroy pi-conv-9 orphan-pvc-sweep",
    ]);

    const kubeDown = deps({ listClaims: () => Promise.reject(new Error("api down")) });
    await new OrphanSweeper(kubeDown.value).run();
    expect(kubeDown.calls).toEqual([`revoke ${UNKNOWN}`]);
  });

  it("reads the session snapshot after listing the resources, so a session created in between is not unknown", async () => {
    const order: string[] = [];
    const { value, calls } = deps({
      listClaims: () => {
        order.push("claims");
        return Promise.resolve([]);
      },
      listPvcs: () => Promise.resolve([]),
      listOneCli: () => {
        order.push("onecli");
        return Promise.resolve({
          agents: [{ id: "a1", identifier: `pi-session-${UNKNOWN}` }],
          secrets: [],
        });
      },
      // The session row is inserted while OneCLI is being listed; a snapshot taken before would miss it.
      listSessions: () => {
        order.push("sessions");
        const created = order.includes("onecli");
        return Promise.resolve(
          created ? [{ id: UNKNOWN, status: "active", conversationId: 1 }] : [],
        );
      },
    });
    await new OrphanSweeper(value).run();
    expect(order.at(-1)).toBe("sessions");
    expect(calls).toEqual([]);
  });

  it("runs one sweep at a time", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { value, calls } = deps({
      destroyClaim: async (claim) => {
        calls.push(claim);
        await gate;
      },
    });
    const sweeper = new OrphanSweeper(value);
    const first = sweeper.run();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await sweeper.run()).toEqual([]);
    release();
    await first;
  });
});
