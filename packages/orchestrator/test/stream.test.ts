import { createServer, request } from "node:http";
import type { Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { Host } from "../src/host.ts";
import { StreamRegistry } from "../src/sessions.ts";
import { liveEvent, parseLastEventId, serveStream, write } from "../src/stream.ts";

describe("parseLastEventId", () => {
  it("reads a positive integer and treats everything else as no cursor", () => {
    expect(parseLastEventId("17")).toBe(17);
    expect(parseLastEventId(undefined)).toBe(0);
    expect(parseLastEventId("abc")).toBe(0);
    expect(parseLastEventId("-3")).toBe(0);
    expect(parseLastEventId("1.5")).toBe(0);
  });
});

describe("liveEvent", () => {
  it("is idle without a run and an empty inbox", () => {
    expect(liveEvent({})).toEqual({ running: false, queued: 0 });
  });

  it("reports the run, the queue, the partial answer and the tool calls", () => {
    const event = liveEvent({
      "pi.live": {
        run: { taskId: 1 },
        generation: {
          attempt: 1,
          message: {
            content: [
              { type: "text", text: "par" },
              { type: "text", text: "tial" },
            ],
          },
        },
        tools: [{ callId: "c1", name: "bash", status: "running" }],
      },
      "pi.inbox": { items: [{ id: 1 }, { id: 2 }] },
    });
    expect(event).toEqual({
      running: true,
      queued: 2,
      partial: "partial",
      tools: [{ callId: "c1", name: "bash", status: "running" }],
    });
  });

  it("surfaces why the newest run ended without an answer", () => {
    expect(liveEvent({ "pi.live": { runFailure: { reason: "aborted" } } })).toMatchObject({
      running: false,
      runFailure: "aborted",
    });
  });
});

describe("write", () => {
  it("leaves no listeners behind after a drain or a close", async () => {
    const res = new PassThrough({ highWaterMark: 1 }) as unknown as ServerResponse;
    const stream = res as unknown as PassThrough;
    for (let i = 0; i < 20; i += 1) {
      const pending = write(res, "chunk");
      stream.read(); // empties the buffer, which emits drain
      await pending;
    }
    expect(stream.listenerCount("close")).toBe(0);
    expect(stream.listenerCount("drain")).toBe(0);

    const closing = write(res, "chunk");
    stream.destroy();
    await closing;
    expect(stream.listenerCount("close")).toBe(0);
    expect(stream.listenerCount("drain")).toBe(0);
  }, 5_000);
});

/** A host whose `watch` resolves only when the test says so, to hold the watch-creation window open. */
function slowHost(): { host: Host; release: () => void; stop: ReturnType<typeof vi.fn> } {
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stop = vi.fn(() => Promise.resolve());
  const watch = {
    value: { entries: [], docs: {} },
    start: vi.fn(),
    stop,
    closed: new Promise<void>(() => undefined),
  };
  const host = {
    watch: async () => {
      await gate;
      return { conversation: {}, watch };
    },
  } as unknown as Host;
  return { host, release, stop };
}

async function withServer(
  handler: (req: import("node:http").IncomingMessage, res: ServerResponse) => Promise<void>,
  run: (port: number) => Promise<void>,
): Promise<void> {
  const server: Server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run((server.address() as AddressInfo).port);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

describe("serveStream", () => {
  it("stops the watch when the client leaves while it is being created", async () => {
    const { host, release, stop } = slowHost();
    const served = Promise.withResolvers<undefined>();
    await withServer(
      async (req, res) => {
        await serveStream(req, res, host, new StreamRegistry(), "s1", 1);
        served.resolve(undefined);
      },
      async (port) => {
        const req = request({ port, host: "127.0.0.1", path: "/" });
        req.on("error", () => undefined);
        req.end();
        await new Promise((resolve) => setTimeout(resolve, 100));
        req.destroy();
        await new Promise((resolve) => setTimeout(resolve, 100)); // the server sees the close before watch resolves
        release();
        await served.promise;
        expect(stop).toHaveBeenCalledTimes(1);
      },
    );
  }, 10_000);

  it("ends a stream that registers while the session is being deleted", async () => {
    const { host, release, stop } = slowHost();
    const streams = new StreamRegistry();
    await withServer(
      async (req, res) => {
        await serveStream(req, res, host, streams, "s1", 1);
      },
      async (port) => {
        const status = new Promise<number>((resolve) => {
          request({ port, host: "127.0.0.1", path: "/" }, (res) => {
            resolve(res.statusCode ?? 0);
            res.resume();
          }).end();
        });
        await new Promise((resolve) => setTimeout(resolve, 100));
        streams.closeSession("s1", "deleted"); // deletion runs while the watch is still being created
        release();
        expect(await status).toBe(410);
        expect(stop).toHaveBeenCalledTimes(1);
      },
    );
  }, 10_000);

  it("refuses a stream whose session was marked deleting before it registered", async () => {
    const { host, release, stop } = slowHost();
    release();
    await withServer(
      async (req, res) => {
        await serveStream(req, res, host, new StreamRegistry(), "s1", 1, () =>
          Promise.resolve(false),
        );
      },
      async (port) => {
        const status = await new Promise<number>((resolve) => {
          request({ port, host: "127.0.0.1", path: "/" }, (res) => {
            resolve(res.statusCode ?? 0);
            res.resume();
          }).end();
        });
        expect(status).toBe(410);
        expect(stop).toHaveBeenCalledTimes(1);
      },
    );
  }, 10_000);
});
