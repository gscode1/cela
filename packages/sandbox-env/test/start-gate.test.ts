import { describe, expect, it } from "vitest";
import { BRIDGE_READY } from "../src/bridge.ts";
import { freeGateOnBridgeLog } from "../src/index.ts";
import { StartGate, gatedStart } from "../src/start-gate.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("StartGate", () => {
  it("lets one holder through at a time, in order", async () => {
    const gate = new StartGate(5_000);
    const order: string[] = [];
    const first = await gate.acquire();
    const second = gate.acquire().then((release) => {
      order.push("second");
      return release;
    });
    const third = gate.acquire().then((release) => {
      order.push("third");
      return release;
    });
    await tick();
    expect(order).toEqual([]);
    first();
    (await second)();
    (await third)();
    expect(order).toEqual(["second", "third"]);
  });

  it("frees the turn on its own if the holder never reports ready", async () => {
    const gate = new StartGate(30);
    await gate.acquire();
    const started = Date.now();
    await gate.acquire();
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
  });

  it("treats a second release as a no-op", async () => {
    const gate = new StartGate(5_000);
    const first = await gate.acquire();
    first();
    first();
    const second = await gate.acquire();
    let thirdRan = false;
    void gate.acquire().then(() => (thirdRan = true));
    first();
    await tick();
    expect(thirdRan).toBe(false);
    second();
    await tick();
    expect(thirdRan).toBe(true);
  });
});

describe("gatedStart", () => {
  it("holds the gate from spawn until the bridge says it is ready", async () => {
    const gate = new StartGate(5_000);
    const a = gatedStart(gate, ["bridge", "--claim", "a"]);
    const b = gatedStart(gate, ["bridge", "--claim", "b"]);
    expect(await a.command()).toEqual(["bridge", "--claim", "a"]);
    let bSpawned = false;
    void b.command().then(() => (bSpawned = true));
    await tick();
    expect(bSpawned).toBe(false);
    a.onLog("unrelated stderr\n");
    await tick();
    expect(bSpawned).toBe(false);
    a.onLog(`${BRIDGE_READY}\n`);
    await tick();
    expect(bSpawned).toBe(true);
  });

  it("frees the gate when a connection closes mid-start, and on a respawn", async () => {
    const gate = new StartGate(5_000);
    const a = gatedStart(gate, ["a"]);
    const b = gatedStart(gate, ["b"]);
    await a.command();
    let bSpawned = false;
    void b.command().then(() => (bSpawned = true));
    a.release();
    await tick();
    expect(bSpawned).toBe(true);
  });

  it("does not take the gate after its connection closed while waiting for a turn", async () => {
    const gate = new StartGate(5_000);
    const a = gatedStart(gate, ["a"]);
    const b = gatedStart(gate, ["b"]);
    const c = gatedStart(gate, ["c"]);
    await a.command();
    const bResult = b.command().then(
      () => "spawned",
      () => "cancelled",
    );
    let cSpawned = false;
    void c.command().then(() => (cSpawned = true));
    b.release(); // the connection closed while queued behind a
    expect(await bResult).toBe("cancelled");
    a.onLog(`${BRIDGE_READY}\n`);
    await tick();
    expect(cSpawned).toBe(true); // b did not take the turn and sit on it
  });

  it("lets a connection respawn without deadlocking on its own earlier turn", async () => {
    const gate = new StartGate(5_000);
    const a = gatedStart(gate, ["a"]);
    await a.command();
    await a.command();
    a.release();
  });
});

describe("freeGateOnBridgeLog", () => {
  it("frees the gate when the bridge reports a failed start, so other sandboxes are not held up", async () => {
    const gate = new StartGate(5_000);
    const failing = gatedStart(gate, ["bridge"]);
    await failing.command();
    freeGateOnBridgeLog(failing, "bridge: cannot start pi-env: spawn failed\n");
    const started = Date.now();
    (await gate.acquire())();
    expect(Date.now() - started).toBeLessThan(1_000);
  }, 10_000);

  it("keeps the gate held for unrelated output until the bridge is ready", async () => {
    const gate = new StartGate(200);
    const start = gatedStart(gate, ["bridge"]);
    await start.command();
    freeGateOnBridgeLog(start, "some warning\n");
    const started = Date.now();
    (await gate.acquire())();
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
  }, 10_000);
});
