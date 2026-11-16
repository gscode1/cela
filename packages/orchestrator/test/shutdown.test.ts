import { describe, expect, it, vi } from "vitest";
import { createShutdown } from "../src/shutdown.ts";
import type { Running } from "../src/shutdown.ts";

function deps(running: Running) {
  const exited = Promise.withResolvers<number>();
  return {
    exited: exited.promise,
    deps: {
      running,
      stop: new AbortController(),
      server: { close: vi.fn(), closeAllConnections: vi.fn() },
      pool: { end: vi.fn(() => Promise.resolve()) },
      exit: (code: number) => exited.resolve(code),
      forceAfterMs: 5_000,
    },
  };
}

describe("createShutdown", () => {
  it("closes a host that is still being opened when the signal arrives", async () => {
    const close = vi.fn(() => Promise.resolve());
    const opened = Promise.withResolvers<{ close(): Promise<void> }>();
    const running: Running = { opening: opened.promise };
    const { deps: d, exited } = deps(running);
    createShutdown(d)("SIGTERM");
    expect(d.stop.signal.aborted).toBe(true);
    opened.resolve({ close }); // Host.open settles after the signal
    expect(await exited).toBe(0);
    expect(close).toHaveBeenCalledTimes(1);
  }, 10_000);

  it("closes an opened host and stops the other parts", async () => {
    const close = vi.fn(() => Promise.resolve());
    const sweeper = { stop: vi.fn() };
    const { deps: d, exited } = deps({ host: { close }, sweeper });
    createShutdown(d)("SIGINT");
    await exited;
    expect(close).toHaveBeenCalledTimes(1);
    expect(sweeper.stop).toHaveBeenCalledTimes(1);
    expect(d.pool.end).toHaveBeenCalledTimes(1);
  }, 10_000);
});
