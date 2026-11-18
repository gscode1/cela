import { connect, type AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createIngestServer } from "../src/server.ts";
import { FakeSettingsDb } from "../../session-core/test/fake-settings-db.ts";

let server: Server | undefined;
afterEach(() => {
  vi.useRealTimers();
  server?.closeAllConnections();
  server?.close();
  server = undefined;
});

describe("ingest request body deadline", () => {
  it(
    "answers 408 to a body that stalls, and closes the connection",
    { timeout: 10_000 },
    async () => {
      const db = new FakeSettingsDb();
      server = createIngestServer({
        pool: db.asPool(),
        authenticate: () => Promise.resolve({ owner: "alice", subject: "static:alice" }),
        orchestratorUrl: "http://unused",
        settings: {
          get: () => {
            throw new Error("not used");
          },
          policy: () => {
            throw new Error("not used");
          },
          refresh: () => Promise.resolve(),
        },
        admins: ["alice"],
        schemaReady: () => true,
      });
      await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as AddressInfo).port;

      const client = connect(port, "127.0.0.1");
      client.write(
        "PUT /admin/settings HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer alice\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{",
      );
      const chunks: Buffer[] = [];
      const closed = new Promise<void>((resolve) => {
        client.on("data", (c: Buffer) => chunks.push(c));
        client.on("close", resolve);
      });
      // Only the body deadline is faked; the server's socket handling keeps real time.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      for (let i = 0; i < 100 && chunks.length === 0; i++) {
        vi.advanceTimersByTime(31_000);
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      vi.useRealTimers();
      await closed;
      const text = Buffer.concat(chunks).toString("utf8");
      expect(text).toMatch(/^HTTP\/1\.1 408 /);
      expect(text).toContain("body not received in time");
    },
  );
});
