import { once } from "node:events";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { parseUpstream, startForwarder, type Forwarder } from "../src/forwarder.js";

const TOKEN = "tok-123_abc";
const expected = `Basic ${Buffer.from(`x:${TOKEN}`).toString("base64")}`;

interface FakeProxy {
  port: number;
  heads: string[];
  close(): Promise<void>;
}

/** An egress proxy stand-in: 407 without the token, 403 for denied.example, else 200 and an echo tunnel. */
async function fakeProxy(): Promise<FakeProxy> {
  const heads: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    let buffered = "";
    const onData = (chunk: Buffer) => {
      buffered += chunk.toString("latin1");
      const end = buffered.indexOf("\r\n\r\n");
      if (end === -1) return;
      socket.removeListener("data", onData);
      const head = buffered.slice(0, end);
      heads.push(head);
      if (!head.includes(`Proxy-Authorization: ${expected}`)) {
        socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      if (head.startsWith("CONNECT denied.example:443")) {
        socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      socket.write("hello:");
      socket.on("data", (data) => socket.write(data));
    };
    socket.on("data", onData);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as net.AddressInfo;
  return {
    port: address.port,
    heads,
    close: () =>
      new Promise<void>((done) => {
        for (const s of sockets) s.destroy();
        server.close(() => {
          done();
        });
      }),
  };
}

async function exchange(port: number, request: string, until: RegExp): Promise<string> {
  const socket = net.connect({ host: "127.0.0.1", port });
  let received = "";
  socket.on("data", (chunk) => {
    received += chunk.toString("latin1");
  });
  await once(socket, "connect");
  socket.write(request);
  const deadline = Date.now() + 5_000;
  while (!until.test(received) && Date.now() < deadline && !socket.destroyed) {
    await new Promise((r) => setTimeout(r, 10));
  }
  socket.destroy();
  return received;
}

let proxy: FakeProxy | undefined;
let forwarder: Forwarder | undefined;
afterEach(async () => {
  await forwarder?.close();
  await proxy?.close();
  proxy = undefined;
  forwarder = undefined;
});

async function start(authorized = true): Promise<{ proxy: FakeProxy; forwarder: Forwarder }> {
  proxy = await fakeProxy();
  forwarder = await startForwarder({
    host: "127.0.0.1",
    port: proxy.port,
    ...(authorized ? { authorization: expected } : {}),
  });
  return { proxy, forwarder };
}

describe("parseUpstream", () => {
  it("reads host, port and the session token as Basic credentials", () => {
    expect(parseUpstream(`http://x:${TOKEN}@10.96.0.7:3128`)).toEqual({
      host: "10.96.0.7",
      port: 3128,
      authorization: expected,
    });
  });
  it("accepts a proxy URL without credentials", () => {
    expect(parseUpstream("http://proxy.example:8080")).toEqual({
      host: "proxy.example",
      port: 8080,
    });
  });
  it("refuses other schemes and garbage without echoing the URL", () => {
    expect(() => parseUpstream("https://x:secret@proxy:3128")).toThrow(/http/);
    try {
      parseUpstream("not a url with secret");
    } catch (error) {
      expect(String(error)).not.toContain("secret");
    }
  });
});

describe("startForwarder", { timeout: 15_000 }, () => {
  it("listens on the loopback address only", async () => {
    const started = await start();
    const server = net.createServer();
    // The forwarder's own port is bound on 127.0.0.1 only: connecting through another address of this host fails.
    const external = Object.values((await import("node:os")).networkInterfaces())
      .flat()
      .find((i) => i?.family === "IPv4" && !i.internal)?.address;
    server.close();
    if (external !== undefined) {
      const socket = net.connect({ host: external, port: started.forwarder.port });
      const [error] = (await once(socket, "error")) as [NodeJS.ErrnoException];
      expect(error.code).toBe("ECONNREFUSED");
    }
    const ok = net.connect({ host: "127.0.0.1", port: started.forwarder.port });
    await once(ok, "connect");
    ok.destroy();
  });

  it("adds the session token to the CONNECT and tunnels bytes both ways", async () => {
    const { proxy: p, forwarder: f } = await start();
    const out = await exchange(
      f.port,
      "CONNECT example.org:443 HTTP/1.1\r\nHost: example.org:443\r\n\r\n",
      /hello:/,
    );
    expect(out).toMatch(/^HTTP\/1\.1 200 /);
    expect(out).toContain("hello:");
    expect(p.heads[0]).toContain("CONNECT example.org:443 HTTP/1.1");
    expect(p.heads[0]).toContain(`Proxy-Authorization: ${expected}`);
  });

  it("relays the browser's early bytes after the CONNECT", async () => {
    const { forwarder: f } = await start();
    const out = await exchange(
      f.port,
      "CONNECT example.org:443 HTTP/1.1\r\n\r\nping",
      /hello:ping/,
    );
    expect(out).toContain("hello:ping");
  });

  it("passes a refusal of the proxy to the browser unchanged", async () => {
    const { forwarder: f } = await start();
    const out = await exchange(f.port, "CONNECT denied.example:443 HTTP/1.1\r\n\r\n", /403/);
    expect(out).toMatch(/^HTTP\/1\.1 403 Forbidden/);
  });

  it("shows the proxy's 407 when it has no token to add", async () => {
    const { forwarder: f } = await start(false);
    const out = await exchange(f.port, "CONNECT example.org:443 HTTP/1.1\r\n\r\n", /407/);
    expect(out).toMatch(/^HTTP\/1\.1 407 /);
  });

  it("refuses plain HTTP requests with 405 and sends nothing upstream", async () => {
    const { proxy: p, forwarder: f } = await start();
    const out = await exchange(
      f.port,
      "GET http://example.org/ HTTP/1.1\r\nHost: example.org\r\n\r\n",
      /405/,
    );
    expect(out).toMatch(/^HTTP\/1\.1 405 /);
    expect(p.heads).toHaveLength(0);
  });

  it.each(["example.org", "a b:443", ":443", "example.org:99999x"])(
    "refuses the malformed target %j with 400 and sends nothing upstream",
    async (target) => {
      const { proxy: p, forwarder: f } = await start();
      const socket = net.connect({ host: "127.0.0.1", port: f.port });
      await once(socket, "connect");
      let received = "";
      socket.on("data", (c) => {
        received += c.toString("latin1");
      });
      // A raw request line: Node's parser may reject the injected CRLF itself, which also closes the connection.
      socket.write(`CONNECT ${target} HTTP/1.1\r\n\r\n`);
      await new Promise((r) => setTimeout(r, 200));
      socket.destroy();
      expect(received === "" || /^HTTP\/1\.1 400 /.test(received)).toBe(true);
      expect(p.heads).toHaveLength(0);
    },
  );

  it("never forwards a header smuggled after the target", async () => {
    const { proxy: p, forwarder: f } = await start();
    await exchange(f.port, "CONNECT example.org:443\r\nX-Evil: 1\r\n\r\n", /hello:/);
    expect(p.heads.join("\n")).not.toContain("X-Evil");
  });

  it("answers 502 when the upstream proxy is unreachable", async () => {
    const closed = net.createServer();
    closed.listen(0, "127.0.0.1");
    await once(closed, "listening");
    const { port } = closed.address() as net.AddressInfo;
    closed.close();
    forwarder = await startForwarder({ host: "127.0.0.1", port });
    const out = await exchange(forwarder.port, "CONNECT example.org:443 HTTP/1.1\r\n\r\n", /502/);
    expect(out).toMatch(/^HTTP\/1\.1 502 /);
  });
});
