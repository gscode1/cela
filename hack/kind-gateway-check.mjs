/* global process, console, setTimeout, clearTimeout, Buffer, URL */
// The gateway check of hack/kind-smoke.sh --onecli. It runs INSIDE the orchestrator pod (`kubectl exec deploy/pi-orchestrator
// -c orchestrator -- node --input-type=module -e "$(cat this file)"`), because only that pod holds the agent token and the
// CA: the token is read from the pod's own environment and is never printed. It makes no model call and reaches no upstream
// host: it proves that the orchestrator's way out (a CONNECT through OneCLI, the agent token, the gateway CA) works.
//
//   1. CONNECT without a token                      -> 407 (the gateway refuses an unknown caller)
//   2. CONNECT example.com:443 with the token       -> 200, then a TLS handshake that VERIFIES against the CA in the
//      ConfigMap (the certificate was minted by the OneCLI gateway), then GET / -> 403: the host is not on the allowlist
//      (rule pi-block-all), answered by the gateway itself, so nothing left the cluster
// With GATEWAY_CHECK_HOST=<allowed host>, check 2 targets it instead, and the answer is whatever that host says (the hook for
// the real-model check, docs/model-credentials.md: no request is made unless you ask for one).
import { readFileSync } from "node:fs";
import { connect as tlsConnect } from "node:tls";
import { connect as tcpConnect } from "node:net";

const gateway = new URL(process.env.PI_ONECLI_GATEWAY ?? "");
const token = process.env.ONECLI_AGENT_TOKEN;
const caFile = process.env.PI_ONECLI_CA_FILE ?? "/etc/onecli/ca.pem";
const host = process.env.GATEWAY_CHECK_HOST ?? "example.com";
if (!token) {
  console.error("gateway-check: ONECLI_AGENT_TOKEN is not set in the orchestrator");
  process.exit(2);
}
const ca = readFileSync(caFile, "utf8");

function readUntil(socket, pattern, ms) {
  return new Promise((resolve, reject) => {
    let data = "";
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${String(pattern)}`)), ms);
    socket.on("data", (chunk) => {
      data += chunk.toString("latin1");
      if (pattern.test(data)) {
        clearTimeout(timer);
        resolve(data);
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on("close", () => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

async function connectThrough(authorization) {
  const socket = tcpConnect({ host: gateway.hostname, port: Number(gateway.port || 80) });
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const headers = [`CONNECT ${host}:443 HTTP/1.1`, `Host: ${host}:443`];
  if (authorization) headers.push(`Proxy-Authorization: ${authorization}`);
  socket.write(`${headers.join("\r\n")}\r\n\r\n`);
  const head = await readUntil(socket, /\r\n\r\n/, 15_000);
  socket.removeAllListeners("data");
  socket.removeAllListeners("error");
  socket.removeAllListeners("close");
  return { socket, status: Number(/^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1] ?? 0) };
}

const refused = await connectThrough(undefined);
console.log(`gateway-check connect-without-token=${String(refused.status)}`);
refused.socket.destroy();

const proxied = await connectThrough(`Basic ${Buffer.from(`x:${token}`).toString("base64")}`);
console.log(`gateway-check connect-with-token=${String(proxied.status)}`);
if (proxied.status !== 200) {
  proxied.socket.destroy();
  process.exit(1);
}
const tls = tlsConnect({ socket: proxied.socket, servername: host, ca: [ca] });
await new Promise((resolve, reject) => {
  tls.once("secureConnect", resolve);
  tls.once("error", reject);
});
const issuer = tls.getPeerCertificate().issuer?.CN ?? "?";
console.log(`gateway-check tls-verified=${String(tls.authorized)} issuer=${issuer}`);
tls.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
const answer = await readUntil(tls, /\r\n\r\n/, 15_000);
console.log(
  `gateway-check answer-status=${/^HTTP\/1\.[01] (\d{3})/.exec(answer)?.[1] ?? "?"} host=${host}`,
);
tls.destroy();
