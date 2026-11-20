import { createServer } from "node:http";
import type { IncomingHttpHeaders, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { inspect } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  bypassesProxy,
  createGatewayFetch,
  parseNoProxy,
  placeholderAuthContext,
  PLACEHOLDER_API_KEY,
  Redacted,
} from "../src/onecli.ts";

const TOKEN = "aoc_0123456789abcdef0123456789abcdef";

describe("Redacted", () => {
  it("never prints, however it is formatted or logged", () => {
    const secret = new Redacted(TOKEN);
    expect(secret.reveal()).toBe(TOKEN);
    expect(JSON.stringify({ token: secret })).not.toContain(TOKEN);
    expect(String(secret)).not.toContain(TOKEN);
    expect(String(secret)).toBe("[redacted]");
    expect(inspect({ onecli: { token: secret } }, { depth: 5 })).not.toContain(TOKEN);
  });
});

describe("placeholderAuthContext", () => {
  it("answers provider key lookups with the placeholder, whatever the process environment holds", async () => {
    process.env.OPENROUTER_API_KEY = "sk-real-should-never-be-used";
    try {
      expect(await placeholderAuthContext.env("OPENROUTER_API_KEY")).toBe(PLACEHOLDER_API_KEY);
      expect(await placeholderAuthContext.env("OPENAI_API_KEY")).toBe(PLACEHOLDER_API_KEY);
      expect(await placeholderAuthContext.env("HOME")).toBeUndefined();
      expect(await placeholderAuthContext.fileExists()).toBe(false);
    } finally {
      delete process.env.OPENROUTER_API_KEY;
    }
  });
});

describe("NO_PROXY matching of IPv6 literals", () => {
  it("matches bare and bracketed entries, with and without a port", () => {
    const noProxy = parseNoProxy("::1,[fd00::5]:8080,[0:0:0:0:0:0:0:2]");
    expect(bypassesProxy(new URL("http://[::1]:9000/"), noProxy)).toBe(true);
    expect(bypassesProxy(new URL("http://[fd00::5]:8080/"), noProxy)).toBe(true);
    expect(bypassesProxy(new URL("http://[fd00::5]:9090/"), noProxy)).toBe(false);
    expect(bypassesProxy(new URL("http://[::2]/"), noProxy)).toBe(true);
    expect(bypassesProxy(new URL("http://[::3]/"), noProxy)).toBe(false);
  });
});

describe("NO_PROXY matching", () => {
  const noProxy = parseNoProxy(
    " .svc, kubernetes.default ,pi-pg-rw,10.0.0.0/8,.cluster.local,db:5432",
  );
  const bypass = (url: string): boolean => bypassesProxy(new URL(url), noProxy);

  it("keeps the cluster, the Kubernetes API and Postgres off the gateway", () => {
    expect(bypass("https://kubernetes.default.svc/api")).toBe(true);
    expect(bypass("https://kubernetes.default/api")).toBe(true);
    expect(bypass("http://sandbox-x.cela-dev.svc:8888/")).toBe(true);
    expect(bypass("http://pi-pg-rw:5432/")).toBe(true);
    expect(bypass("http://pi-pg-rw.cela-dev.svc.cluster.local:5432/")).toBe(true);
    expect(bypass("http://10.43.0.1:443/")).toBe(true);
    expect(bypass("http://db:5432/")).toBe(true);
  });

  it("sends public model hosts through it", () => {
    expect(bypass("https://openrouter.ai/api/v1/chat/completions")).toBe(false);
    expect(bypass("https://api.openai.com/v1/responses")).toBe(false);
    expect(bypass("http://db:8080/")).toBe(false);
    expect(bypass("http://11.0.0.1/")).toBe(false);
    // Suffix matching is on whole labels.
    expect(bypass("https://evilsvc/")).toBe(false);
    expect(bypass("https://notpi-pg-rw/")).toBe(false);
  });

  it("supports the wildcard", () => {
    expect(bypassesProxy(new URL("https://openrouter.ai/"), ["*"])).toBe(true);
  });
});

describe("createGatewayFetch", () => {
  const servers: Server[] = [];
  afterEach(() => {
    for (const server of servers.splice(0)) server.close();
  });

  async function listen(
    onRequest: (url: string, headers: IncomingHttpHeaders) => void,
  ): Promise<string> {
    const server = createServer((req, res) => {
      onRequest(req.url ?? "", req.headers);
      res.end("ok");
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  }

  it("sends model calls to the gateway with the agent token, and bypassed hosts directly", async () => {
    const viaGateway: { url: string; headers: IncomingHttpHeaders }[] = [];
    const direct: string[] = [];
    const gateway = await listen((url, headers) => viaGateway.push({ url, headers }));
    const local = await listen((url) => direct.push(url));
    const fetchViaGateway = createGatewayFetch({
      gateway,
      token: new Redacted(TOKEN),
      ca: "",
      noProxy: ["127.0.0.1"],
    });

    // Plain http so the fake gateway sees the whole request; https adds a CONNECT tunnel and the same header.
    const modelCall = await fetchViaGateway("http://models.example.test/v1/chat/completions", {
      method: "POST",
      body: "{}",
    });
    expect(await modelCall.text()).toBe("ok");
    expect(viaGateway).toHaveLength(1);
    expect(viaGateway[0]?.url).toBe("http://models.example.test/v1/chat/completions");
    const expected = `Basic ${Buffer.from(`x:${TOKEN}`).toString("base64")}`;
    expect(viaGateway[0]?.headers["proxy-authorization"]).toBe(expected);

    await (await fetchViaGateway(`${local}/health`)).text();
    expect(direct).toEqual(["/health"]);
    expect(viaGateway).toHaveLength(1);
  });

  it("does not change the process-wide fetch or proxy settings", () => {
    const before = globalThis.fetch;
    createGatewayFetch({
      gateway: "http://127.0.0.1:1",
      token: new Redacted(TOKEN),
      ca: "",
      noProxy: [],
    });
    expect(globalThis.fetch).toBe(before);
    expect(process.env.HTTPS_PROXY).toBeUndefined();
    expect(process.env.HTTP_PROXY).toBeUndefined();
  });
});
