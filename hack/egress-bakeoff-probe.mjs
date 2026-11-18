/* global process, console, fetch, Buffer, URL, setTimeout, setInterval, clearInterval, clearTimeout, AbortSignal */
// The client of hack/egress-bakeoff.sh (issue #264). It runs INSIDE a session's sandbox, with the node binary that the script
// copies into the workspace (the sandbox image has no curl), and talks to the egress proxy exactly like a tool would: HTTPS_PROXY
// carries the session's egress token. Everything goes through that proxy; nothing here reads a credential, and the secrets in
// the test are dummy values that OneCLI injects.
//
//   probe.mjs tls <host>               CONNECT, then a TLS handshake offering h2 and http/1.1, certificate NOT enforced:
//                                      prints what the client was shown (issuer, whether it verifies, the negotiated ALPN)
//   probe.mjs h2 <host> <path>         CONNECT, TLS with ALPN h2, one HTTP/2 request (certificate enforced)
//   probe.mjs ws <host> <path>         CONNECT, TLS, a WebSocket upgrade, one text frame out, the frames that come back
//   probe.mjs fetch <manual|follow> <url>...
//                                      fetch through HTTPS_PROXY (NODE_USE_ENV_PROXY=1), all URLs at once; one line each
//                                      with the status, the Location header, and the dummy credentials found in the body
//   probe.mjs conn <host> <port>       only the CONNECT: prints the proxy's status line
// Every line is `<tag> <key>=<value> ...`; the script greps for them.
import crypto from "node:crypto";
import http2 from "node:http2";
import net from "node:net";
import tls from "node:tls";

const [command, ...args] = process.argv.slice(2);
const proxy = new URL(process.env.HTTPS_PROXY ?? "http://invalid");
const TOKEN = /smoke-[a-z]+-[0-9a-f]{12}/g;

function tunnel(host, port = 443) {
  return new Promise((resolve, reject) => {
    const s = net.connect(Number(proxy.port), proxy.hostname);
    const fail = (code, message) => {
      s.destroy();
      reject(Object.assign(new Error(message ?? code), { code }));
    };
    s.setTimeout(20000, () => fail("TIMEOUT"));
    s.once("error", (e) => fail(e.code ?? "ERROR", e.message));
    s.once("connect", () => {
      const auth = Buffer.from(
        `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`,
      ).toString("base64");
      s.write(
        `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`,
      );
    });
    let buf = Buffer.alloc(0);
    s.on("data", function onData(d) {
      buf = Buffer.concat([buf, d]);
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      s.off("data", onData);
      s.setTimeout(0);
      const line = buf.subarray(0, buf.indexOf("\r\n")).toString();
      const status = Number(line.split(" ")[1]);
      const rest = buf.subarray(end + 4);
      if (status !== 200) return fail(`CONNECT_${String(status)}`, line);
      if (rest.length > 0) s.unshift(rest);
      resolve({ socket: s, line });
    });
  });
}

function secure(socket, host, options) {
  return new Promise((resolve, reject) => {
    const t = tls.connect({ socket, servername: host, ...options });
    t.once("secureConnect", () => resolve(t));
    t.once("error", reject);
  });
}

const issuer = (t) => {
  const cert = t.getPeerCertificate();
  return String(cert?.issuer?.CN ?? cert?.issuer?.O ?? "none").replace(/\s+/g, "_");
};
const errorCode = (e) =>
  String(e?.code ?? e?.cause?.code ?? e?.message ?? "error").replace(/\s+/g, "_");

async function main() {
  switch (command) {
    case "conn": {
      try {
        const { line, socket } = await tunnel(args[0], Number(args[1] ?? 443));
        socket.destroy();
        console.log(`conn status=${line.split(" ")[1]}`);
      } catch (e) {
        console.log(`conn status=${errorCode(e).replace("CONNECT_", "")}`);
      }
      return;
    }
    case "tls": {
      const { socket } = await tunnel(args[0]);
      const t = await secure(socket, args[0], {
        ALPNProtocols: ["h2", "http/1.1"],
        rejectUnauthorized: false,
      });
      console.log(
        `tls verified=${String(t.authorized)} reason=${t.authorizationError ?? "none"} alpn=${t.alpnProtocol || "none"} issuer=${issuer(t)}`,
      );
      t.destroy();
      return;
    }
    case "h2": {
      const [host, path] = args;
      const { socket } = await tunnel(host);
      const t = await secure(socket, host, { ALPNProtocols: ["h2"] });
      console.log(`h2 alpn=${t.alpnProtocol || "none"}`);
      if (t.alpnProtocol !== "h2") {
        t.destroy();
        return;
      }
      const client = http2.connect(`https://${host}`, { createConnection: () => t });
      client.on("error", (e) => console.log(`h2 error=${errorCode(e)}`));
      const req = client.request({ ":path": path, accept: "application/json" });
      let body = "";
      req.on("response", (h) => console.log(`h2 status=${String(h[":status"])}`));
      req.setEncoding("utf8");
      req.on("data", (c) => (body += c));
      await new Promise((resolve) => req.on("close", resolve));
      console.log(`h2 tokens=${[...new Set(body.match(TOKEN) ?? [])].join(",") || "none"}`);
      client.close();
      return;
    }
    case "ws": {
      const [host, path] = args;
      const { socket } = await tunnel(host);
      const t = await secure(socket, host, { ALPNProtocols: ["http/1.1"] });
      const key = crypto.randomBytes(16).toString("base64");
      t.write(
        `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nOrigin: https://${host}\r\n\r\n`,
      );
      let buf = Buffer.alloc(0);
      let all = "";
      let upgraded = false;
      const texts = [];
      let head = "";
      const sent = "pi-bakeoff-ping";
      const sendFrame = () => {
        const payload = Buffer.from(sent);
        const mask = crypto.randomBytes(4);
        const frame = Buffer.concat([
          Buffer.from([0x81, 0x80 | payload.length]),
          mask,
          Buffer.from(payload.map((b, i) => b ^ mask[i % 4])),
        ]);
        t.write(frame);
      };
      t.on("data", (d) => {
        all += d.toString("latin1");
        buf = Buffer.concat([buf, d]);
        if (!upgraded) {
          const end = buf.indexOf("\r\n\r\n");
          if (end < 0) return;
          head = buf.subarray(0, end).toString();
          buf = buf.subarray(end + 4);
          upgraded = / 101 /.test(head.split("\r\n")[0]);
          if (upgraded) sendFrame();
          else return; // an origin that ignores the upgrade answers a plain response: read its body below
        }
        for (;;) {
          if (buf.length < 2) return;
          let len = buf[1] & 0x7f;
          let at = 2;
          if (len === 126) {
            if (buf.length < 4) return;
            len = buf.readUInt16BE(2);
            at = 4;
          }
          if (buf.length < at + len) return;
          if ((buf[0] & 0x0f) === 1) texts.push(buf.subarray(at, at + len).toString());
          buf = buf.subarray(at + len);
        }
      });
      await new Promise((resolve) => {
        const poll = setInterval(() => {
          if (texts.includes(sent)) done();
        }, 100);
        const timer = setTimeout(() => done(), 3000);
        function done() {
          clearInterval(poll);
          clearTimeout(timer);
          resolve();
        }
        t.on("close", done);
      });
      const line = head.split("\r\n")[0] ?? "";
      const why = upgraded
        ? ""
        : ` head=${head.replace(/\s+/g, " ").slice(0, 100)} body=${buf.toString().replace(/\s+/g, " ").slice(0, 160)}`;
      console.log(
        `ws status=${line.split(" ")[1] ?? "none"} echoed=${String(texts.includes(sent))}${why}`,
      );
      console.log(`ws tokens=${[...new Set(all.match(TOKEN) ?? [])].join(",") || "none"}`);
      t.destroy();
      return;
    }
    case "fetch": {
      const [mode, ...urls] = args;
      await Promise.all(
        urls.map(async (url, i) => {
          try {
            const r = await fetch(url, { redirect: mode, signal: AbortSignal.timeout(30000) });
            const body = await r.text();
            const found = [...new Set(body.match(TOKEN) ?? [])].join(",") || "none";
            const why = r.status >= 400 ? ` body=${body.replace(/\s+/g, " ").slice(0, 160)}` : "";
            console.log(
              `fetch n=${String(i)} status=${String(r.status)} location=${r.headers.get("location") ?? "none"} url=${r.url} tokens=${found}${why}`,
            );
          } catch (e) {
            console.log(
              `fetch n=${String(i)} status=000 error=${errorCode(e)} url=${url} tokens=none`,
            );
          }
        }),
      );
      return;
    }
    default:
      throw new Error(`unknown command ${String(command)}`);
  }
}

main()
  .catch((e) => {
    console.log(`${command} error=${errorCode(e)}`);
  })
  .finally(() => process.exit(0));
