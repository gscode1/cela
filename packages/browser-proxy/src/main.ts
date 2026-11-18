import { parseUpstream, startForwarder } from "./forwarder.js";

/**
 * `browser-proxy`: the loopback forwarder of the browser sandbox. The upstream is the session's `HTTPS_PROXY`, the
 * environment every tool command already gets (ADR 0036); the listening port is BROWSER_PROXY_PORT (default 3129).
 */
const proxyUrl = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? "";
const port = Number(process.env.BROWSER_PROXY_PORT ?? "3129");
try {
  if (proxyUrl === "") throw new Error("HTTPS_PROXY is not set: this session has no egress proxy");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("BROWSER_PROXY_PORT is not a port");
  const upstream = parseUpstream(proxyUrl);
  const forwarder = await startForwarder(upstream, { port });
  process.stderr.write(
    `browser-proxy: listening on 127.0.0.1:${String(forwarder.port)}, upstream ${upstream.host}:${String(upstream.port)}\n`,
  );
  const stop = () => {
    void forwarder.close().then(() => process.exit(0));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
} catch (error) {
  process.stderr.write(
    `browser-proxy: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
}
