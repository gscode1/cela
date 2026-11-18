import { createServer, type IncomingMessage, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { BodyTimeoutError, readJsonObject, sendBodyError } from "../src/http.ts";

let server: Server | undefined;
afterEach(() => {
  server?.closeAllConnections();
  server?.close();
  server = undefined;
});

describe("readJsonObject deadline", () => {
  it(
    "throws BodyTimeoutError when the body never ends, and still reads a prompt body",
    { timeout: 5000 },
    async () => {
      const stalled = new PassThrough();
      stalled.write('{"a":');
      await expect(
        readJsonObject(stalled as unknown as IncomingMessage, 1024, 50),
      ).rejects.toBeInstanceOf(BodyTimeoutError);
      const prompt = new PassThrough();
      prompt.end('{"a":1}');
      await expect(readJsonObject(prompt as unknown as IncomingMessage, 1024, 50)).resolves.toEqual(
        {
          a: 1,
        },
      );
    },
  );

  it("answers 408 and then destroys the stalled request", { timeout: 5000 }, async () => {
    let seen: IncomingMessage | undefined;
    server = createServer((req, res) => {
      seen = req;
      readJsonObject(req, 1024, 50).catch((error: unknown) => {
        sendBodyError(res, req, error);
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const client = connect(port, "127.0.0.1");
    client.write("POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\n{");
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve) => {
      client.on("data", (c: Buffer) => chunks.push(c));
      client.on("close", resolve);
    });
    const text = Buffer.concat(chunks).toString("utf8");
    expect(text).toMatch(/^HTTP\/1\.1 408 /);
    expect(text).toContain("body not received in time");
    expect(seen?.destroyed).toBe(true);
  });
});
