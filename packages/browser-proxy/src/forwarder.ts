import { createServer, type IncomingMessage, type Server } from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";

/** The egress proxy a forwarder tunnels through (docs/decisions/0041-browser-sandbox.md). */
export interface Upstream {
  host: string;
  port: number;
  /** Value of `Proxy-Authorization`; absent when the proxy URL carries no credentials. */
  authorization?: string;
}

/**
 * Reads the proxy URL a sandbox command gets (`HTTPS_PROXY`, ADR 0036: `http://x:<token>@<address>:3128`). The
 * token is decoded and re-encoded as Basic credentials; it never reaches a log line or an error message.
 */
export function parseUpstream(proxyUrl: string): Upstream {
  let url: URL;
  try {
    url = new URL(proxyUrl);
  } catch {
    throw new Error("the proxy URL is not a URL");
  }
  if (url.protocol !== "http:") throw new Error("the proxy URL must be http://");
  const port = url.port === "" ? 80 : Number(url.port);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const upstream: Upstream = { host, port };
  if (url.username !== "" || url.password !== "") {
    const credentials = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
    upstream.authorization = `Basic ${Buffer.from(credentials).toString("base64")}`;
  }
  return upstream;
}

// host:port with nothing a header line could be split on; the upstream proxy applies the rules.
const TARGET = /^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\]):[0-9]{1,5}$/;
const MAX_RESPONSE_HEAD = 16 * 1024;

export interface Forwarder {
  /** The loopback port it listens on. */
  port: number;
  close(): Promise<void>;
}

/**
 * Listens on 127.0.0.1 and answers `CONNECT host:port` by opening a CONNECT to the upstream proxy with the session's
 * credentials, then relaying bytes both ways. Chromium ignores `user:pass@` in `--proxy-server`, so without this its
 * tunnels would get 407 from a proxy that requires the session token. Everything else is refused: the proxy itself
 * answers CONNECT only (ADR 0036), so a plain `http://` request has nowhere to go.
 */
export function startForwarder(
  upstream: Upstream,
  options: { port?: number; connectTimeoutMs?: number } = {},
): Promise<Forwarder> {
  const connectTimeoutMs = options.connectTimeoutMs ?? 15_000;
  const server: Server = createServer((_req, res) => {
    res.writeHead(405, { Allow: "CONNECT", Connection: "close" });
    res.end("only CONNECT is forwarded\n");
  });
  server.on("connect", (req: IncomingMessage, client: Duplex, head: Buffer) => {
    tunnel(upstream, req.url ?? "", client, head, connectTimeoutMs);
  });
  server.on("clientError", (_error, socket) => {
    socket.destroy();
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    // The address is fixed on purpose: a browser sandbox's forwarder must never be reachable from another Pod.
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("no listening address"));
        return;
      }
      server.removeListener("error", reject);
      resolve({
        port: address.port,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => {
              done();
            });
          }),
      });
    });
  });
}

function refuse(client: Duplex, status: string): void {
  client.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function tunnel(
  upstream: Upstream,
  target: string,
  client: Duplex,
  head: Buffer,
  connectTimeoutMs: number,
): void {
  if (!TARGET.test(target)) {
    refuse(client, "400 Bad Request");
    return;
  }
  const remote = net.connect({ host: upstream.host, port: upstream.port });
  remote.setTimeout(connectTimeoutMs);
  const fail = (status: string) => {
    remote.destroy();
    refuse(client, status);
  };
  client.on("error", () => remote.destroy());
  remote.on("error", () => {
    if (client.writable && !client.destroyed) fail("502 Bad Gateway");
    else client.destroy();
  });
  remote.on("timeout", () => {
    if (client.writable && !client.destroyed) fail("504 Gateway Timeout");
    else remote.destroy();
  });
  remote.once("connect", () => {
    const lines = [`CONNECT ${target} HTTP/1.1`, `Host: ${target}`];
    if (upstream.authorization !== undefined) {
      lines.push(`Proxy-Authorization: ${upstream.authorization}`);
    }
    remote.write(`${lines.join("\r\n")}\r\n\r\n`);
  });

  let buffered = Buffer.alloc(0);
  const onData = (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    const end = buffered.indexOf("\r\n\r\n");
    if (end === -1) {
      if (buffered.length > MAX_RESPONSE_HEAD) fail("502 Bad Gateway");
      return;
    }
    remote.removeListener("data", onData);
    remote.setTimeout(0);
    const responseHead = buffered.subarray(0, end + 4);
    const rest = buffered.subarray(end + 4);
    const status = /^HTTP\/1\.[01] (\d{3})/.exec(responseHead.toString("latin1"))?.[1];
    // The proxy's answer reaches the browser unchanged: its 403 and 407 bodies say why a host was refused.
    client.write(responseHead);
    if (status === undefined || !status.startsWith("2")) {
      client.end(rest);
      remote.destroy();
      return;
    }
    if (rest.length > 0) client.write(rest);
    if (head.length > 0) remote.write(head);
    client.pipe(remote);
    remote.pipe(client);
    client.on("close", () => remote.destroy());
    remote.on("close", () => client.destroy());
  };
  remote.on("data", onData);
}
