import { rootCertificates } from "node:tls";
import { fetch as undiciFetch, ProxyAgent } from "undici";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type { FetchFunction, Models } from "@earendil-works/pi-ai";
import type { MutableModels } from "@earendil-works/pi-ai/models";

/**
 * A secret that never prints. `JSON.stringify`, template strings and `util.inspect` (so `console.log` and our
 * logger) all give `[redacted]`; only `reveal()` returns the value.
 */
export class Redacted {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toJSON(): string {
    return "[redacted]";
  }

  toString(): string {
    return "[redacted]";
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "[redacted]";
  }
}

/** How the orchestrator reaches model providers through the OneCLI gateway. */
export interface OneCliConfig {
  /** Proxy URL of the gateway, `http://onecli.onecli:10255`. No credentials in it: the token travels separately. */
  gateway: string;
  /** The orchestrator's OneCLI agent token (`aoc_...`), from the Secret `pi-onecli`. */
  token: Redacted;
  /** PEM of the OneCLI gateway CA, which signs the certificates the gateway presents for the model hosts. */
  ca: string;
  /** `NO_PROXY` entries: hosts that are reached directly, never through the gateway. */
  noProxy: readonly string[];
}

/** Placeholder every provider's API-key lookup resolves to. The gateway replaces it with the real credential. */
export const PLACEHOLDER_API_KEY = "onecli-managed-placeholder";

/**
 * The pi-ai auth context: provider API keys and tokens resolve to a placeholder, whatever the process
 * environment holds, and files never exist. The orchestrator therefore never carries a real provider
 * credential, and a real one that sneaks into the environment is not used.
 */
export const placeholderAuthContext = {
  env: (name: string): Promise<string | undefined> =>
    Promise.resolve(
      /(_API_KEY|_API_TOKEN|_ACCESS_TOKEN)$/.test(name) ? PLACEHOLDER_API_KEY : undefined,
    ),
  fileExists: (): Promise<boolean> => Promise.resolve(false),
};

/**
 * The OpenAI Codex (ChatGPT subscription) provider has no API-key auth, only a stored OAuth login, and pi-ai reads the
 * `chatgpt-account-id` header value out of the access token (a JWT, claim `https://api.openai.com/auth`.
 * `chatgpt_account_id`). The gateway replaces both `Authorization` and `chatgpt-account-id` with the real login, so
 * the orchestrator holds this unsigned, JWT-shaped stand-in instead of a login.
 */
export function codexPlaceholderToken(accountId: string): string {
  const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none", typ: "JWT" })}.${part({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })}.${PLACEHOLDER_API_KEY}`;
}

/** An in-memory credential store holding the Codex placeholder login, valid far beyond any refresh window. */
export async function placeholderCredentials(accountId: string): Promise<InMemoryCredentialStore> {
  const store = new InMemoryCredentialStore();
  await store.modify("openai-codex", () =>
    Promise.resolve({
      type: "oauth" as const,
      access: codexPlaceholderToken(accountId),
      refresh: PLACEHOLDER_API_KEY,
      expires: Date.now() + 10 * 365 * 24 * 3600 * 1000,
    }),
  );
  return store;
}

export function parseNoProxy(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== "");
}

/**
 * `NO_PROXY` matching as curl and Go do it: `*` matches everything, `.suffix` and `suffix` match the host and its
 * subdomains, an IPv4 CIDR matches addresses in the block, and a port, when given, must match.
 */
export function bypassesProxy(url: URL, noProxy: readonly string[]): boolean {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  for (const entry of noProxy) {
    if (entry === "*") return true;
    const [pattern, entryPort] = splitPort(entry);
    if (entryPort !== undefined && entryPort !== port) continue;
    if (pattern.includes("/")) {
      if (inCidr(host, pattern)) return true;
      continue;
    }
    const bare = pattern.replace(/^\*?\./, "");
    if (host === bare || host.endsWith(`.${bare}`)) return true;
  }
  return false;
}

/** An IPv6 literal in the canonical form of `URL.hostname` (without brackets), so `::1` equals `0:0:0:0:0:0:0:1`. */
function canonicalIpv6(address: string): string {
  try {
    return new URL(`http://[${address}]/`).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return address;
  }
}

function splitPort(entry: string): [string, string | undefined] {
  // `[::1]:8080` (port optional) and a bare `::1`: a colon in an IPv6 literal is not a port separator.
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(entry);
  if (bracketed?.[1] !== undefined) return [canonicalIpv6(bracketed[1]), bracketed[2]];
  if (entry.split(":").length > 2) return [canonicalIpv6(entry), undefined];
  const match = /^(.*):(\d+)$/.exec(entry);
  return match?.[1] === undefined ? [entry, undefined] : [match[1], match[2]];
}

function ipv4ToInt(address: string): number | undefined {
  const parts = address.split(".");
  if (parts.length !== 4) return undefined;
  let value = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!/^\d{1,3}$/.test(part) || octet > 255) return undefined;
    value = value * 256 + octet;
  }
  return value;
}

function inCidr(host: string, cidr: string): boolean {
  const [network = "", bitsText = ""] = cidr.split("/");
  const address = ipv4ToInt(host);
  const base = ipv4ToInt(network);
  const bits = Number(bitsText);
  if (address === undefined || base === undefined || !Number.isInteger(bits)) return false;
  if (bits < 0 || bits > 32) return false;
  const size = 2 ** (32 - bits);
  return Math.floor(address / size) === Math.floor(base / size);
}

/**
 * A `fetch` for the orchestrator's own outbound calls: the model calls and the remote MCP calls (src/mcp.ts,
 * docs/decisions/0007-native-remote-mcp.md). Requests go through the OneCLI gateway with the orchestrator's agent token
 * (`Proxy-Authorization`, basic with any username) and trust the gateway CA for the certificates it issues.
 * The dispatcher belongs to this function: nothing sets a process-wide proxy or changes the global dispatcher,
 * so the Kubernetes client, Postgres and the bridges are never proxied. Hosts in `noProxy` skip the gateway.
 */
export function createGatewayFetch(config: OneCliConfig): FetchFunction {
  const proxy = new ProxyAgent({
    uri: config.gateway,
    token: `Basic ${Buffer.from(`x:${config.token.reveal()}`).toString("base64")}`,
    requestTls: { ca: [...rootCertificates, config.ca] },
  });
  const gatewayFetch = (
    input: Parameters<FetchFunction>[0],
    init?: Parameters<FetchFunction>[1],
  ) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (bypassesProxy(url, config.noProxy)) return globalThis.fetch(input, init);
    // undici's fetch and its own ProxyAgent: the same undici version on both sides of the dispatcher call.
    return undiciFetch(
      input as Parameters<typeof undiciFetch>[0],
      { ...init, dispatcher: proxy } as Parameters<typeof undiciFetch>[1],
    ) as unknown as ReturnType<FetchFunction>;
  };
  return gatewayFetch;
}

/**
 * The `Models` the Harness sees, with every stream request carrying `fetch`. Pi Durable has no per-conversation
 * hook for pi-ai's `fetch` option, so the wrapper adds it where the Harness calls `streamSimple` and `stream`.
 */
export function withFetch(models: MutableModels, fetch: FetchFunction): Models {
  return new Proxy(models, {
    get(target, property, receiver): unknown {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      const method = value as (...args: unknown[]) => unknown;
      if (
        property === "streamSimple" ||
        property === "stream" ||
        property === "completeSimple" ||
        property === "complete"
      ) {
        return (model: unknown, context: unknown, options?: Record<string, unknown>) =>
          // `sse`: the Codex provider defaults to a WebSocket, which is not proven through the gateway.
          method.call(target, model, context, {
            transport: "sse",
            ...options,
            fetch: options?.fetch ?? fetch,
          });
      }
      return method.bind(target);
    },
  });
}
