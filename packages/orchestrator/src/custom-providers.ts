import { isIP } from "node:net";
import type { FetchFunction, OpenAICompletionsCompat } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

/**
 * Operator-defined OpenAI-compatible model providers (docs/decisions/0056-custom-model-providers.md).
 *
 * They come from the chart (`models.customProviders`, rendered into the ConfigMap `pi-custom-providers`, env
 * `PI_CUSTOM_MODEL_PROVIDERS`) and are the same on every shard. Nothing here is reachable from the admin API: a base URL
 * that skips OneCLI must come from the chart, which also renders the NetworkPolicy rule for it.
 */

/** Env var holding the providers as JSON (a list of the objects documented in charts/cela/values.yaml). */
export const CUSTOM_PROVIDERS_ENV = "PI_CUSTOM_MODEL_PROVIDERS";

/**
 * `onecli`: HTTPS to a host name through the OneCLI gateway, which injects the real key. `direct`: no gateway and no
 * credential, for a keyless LAN server; the chart opens one egress rule for it.
 */
export type CustomProviderTransport = "onecli" | "direct";

export interface CustomModel {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: ("text" | "image")[];
}

export interface CustomProvider {
  id: string;
  baseUrl: string;
  via: CustomProviderTransport;
  /** Direct providers only: what the chart opens in the orchestrator's NetworkPolicy. */
  egress?: { cidr: string; port: number };
  compat: OpenAICompletionsCompat;
  models: CustomModel[];
}

/** Address ranges a direct provider may never use: link-local (cloud metadata), CGNAT (node networks), loopback. */
const FORBIDDEN_RANGES = ["169.254.0.0/16", "100.64.0.0/10", "127.0.0.0/8"] as const;

const PROVIDER_ID = /^[a-z][a-z0-9-]*$/;
const PROVIDER_KEYS = new Set(["id", "baseUrl", "via", "egress", "models", "compat"]);
const MODEL_KEYS = new Set(["id", "name", "contextWindow", "maxTokens", "reasoning", "input"]);

/** The plain-boolean flags of pi-ai's openai-completions `compat`, and its two enums, that an operator may set. */
const COMPAT_BOOLEANS = [
  "supportsStore",
  "supportsDeveloperRole",
  "supportsReasoningEffort",
  "supportsUsageInStreaming",
  "supportsFinishReason",
  "requiresToolResultName",
  "requiresAssistantAfterToolResult",
  "requiresNonNullAssistantContent",
  "requiresToolsWithToolHistory",
  "requiresThinkingAsText",
  "requiresReasoningContentOnAssistantMessages",
] as const;
const MAX_TOKENS_FIELDS = ["max_completion_tokens", "max_tokens"] as const;
const THINKING_FORMATS = [
  "ant-ling",
  "baseten",
  "chat-template",
  "deepseek",
  "openai",
  "openrouter",
  "qwen",
  "qwen-chat-template",
  "string-thinking",
  "together",
  "zai",
] as const;

/** Names that look like a credential: refused with a pointer to OneCLI instead of the generic unknown-field error. */
const CREDENTIAL_NAME = /key|token|secret|auth|password|credential|header/i;

/** Provider ids a custom provider may not take: pi-ai's builtin ones and the two local ones. */
export function reservedProviderIds(): Set<string> {
  return new Set([...builtinProviders().map((provider) => provider.id), "scripted", "faux"]);
}

type Obj = Record<string, unknown>;

function object(value: unknown, path: string): Obj {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${path} must be an object`);
  return value as Obj;
}

function knownKeys(value: Obj, allowed: ReadonlySet<string>, path: string): void {
  for (const key of Object.keys(value)) {
    if (allowed.has(key)) continue;
    if (CREDENTIAL_NAME.test(key)) {
      throw new Error(
        `${path}.${key}: custom providers hold no credential; a key lives in OneCLI as a generic secret (docs/model-credentials.md)`,
      );
    }
    throw new Error(`${path}.${key} is not a known field`);
  }
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${path} must be a string`);
  return value;
}

function count(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1)
    throw new Error(`${path} must be a whole number of 1 or more`);
  return value;
}

function ipv4ToInt(address: string): number | undefined {
  const parts = address.split(".");
  if (parts.length !== 4) return undefined;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return undefined;
    value = value * 256 + Number(part);
  }
  return value;
}

interface Range {
  first: number;
  last: number;
}

/** The first and last address of an IPv4 CIDR (`a.b.c.d/n`), or undefined for anything else. */
function cidrRange(cidr: string): Range | undefined {
  const match = /^([\d.]+)\/(\d{1,2})$/.exec(cidr);
  const address = match?.[1] === undefined ? undefined : ipv4ToInt(match[1]);
  const bits = Number(match?.[2]);
  if (address === undefined || !Number.isInteger(bits) || bits > 32) return undefined;
  const size = 2 ** (32 - bits);
  const first = Math.floor(address / size) * size;
  return { first, last: first + size - 1 };
}

/** The forbidden range `range` touches, if any. */
function overlapsForbidden(range: Range): string | undefined {
  return FORBIDDEN_RANGES.find((forbidden) => {
    const other = cidrRange(forbidden);
    return other !== undefined && range.first <= other.last && range.last >= other.first;
  });
}

function hostOf(url: URL): string {
  return url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
}

function parseBaseUrl(value: unknown, path: string): URL {
  let url: URL;
  try {
    url = new URL(text(value, path));
  } catch {
    throw new Error(`${path} is not an absolute http(s) URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error(`${path} must be an http or https URL`);
  if (url.username !== "" || url.password !== "")
    throw new Error(`${path} must not carry credentials; a key lives in OneCLI`);
  if (url.search !== "" || url.hash !== "")
    throw new Error(`${path} must have no query or fragment`);
  return url;
}

function urlPort(url: URL): number {
  return url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
}

function parseCompat(value: unknown, path: string): OpenAICompletionsCompat {
  const raw = value === undefined ? {} : object(value, path);
  knownKeys(raw, new Set<string>([...COMPAT_BOOLEANS, "maxTokensField", "thinkingFormat"]), path);
  // Servers behind an OpenAI-compatible URL mostly lack the `developer` role and `reasoning_effort`; left unset,
  // pi-ai would guess from the URL and may send them.
  const result: OpenAICompletionsCompat = {
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
  };
  for (const name of COMPAT_BOOLEANS) {
    const flag = raw[name];
    if (flag === undefined) continue;
    if (typeof flag !== "boolean") throw new Error(`${path}.${name} must be true or false`);
    result[name] = flag;
  }
  if (raw.maxTokensField !== undefined) {
    const found = MAX_TOKENS_FIELDS.find((candidate) => candidate === raw.maxTokensField);
    if (found === undefined)
      throw new Error(`${path}.maxTokensField must be ${MAX_TOKENS_FIELDS.join(" or ")}`);
    result.maxTokensField = found;
  }
  if (raw.thinkingFormat !== undefined) {
    const found = THINKING_FORMATS.find((candidate) => candidate === raw.thinkingFormat);
    if (found === undefined)
      throw new Error(`${path}.thinkingFormat must be one of ${THINKING_FORMATS.join(", ")}`);
    result.thinkingFormat = found;
  }
  return result;
}

function parseModel(value: unknown, path: string): CustomModel {
  const raw = object(value, path);
  knownKeys(raw, MODEL_KEYS, path);
  const id = text(raw.id, `${path}.id`);
  // The allowlist is a comma separated list of provider/model pairs.
  if (/[\s,]/.test(id)) throw new Error(`${path}.id must not contain spaces or commas`);
  const contextWindow = count(raw.contextWindow, `${path}.contextWindow`);
  const maxTokens = count(raw.maxTokens, `${path}.maxTokens`);
  if (maxTokens > contextWindow) throw new Error(`${path}.maxTokens must not exceed contextWindow`);
  if (raw.reasoning !== undefined && typeof raw.reasoning !== "boolean")
    throw new Error(`${path}.reasoning must be true or false`);
  const kinds: unknown = raw.input ?? ["text"];
  if (!Array.isArray(kinds)) throw new Error(`${path}.input must be a list of text and image`);
  const input: CustomModel["input"] = [];
  for (const kind of kinds as unknown[]) {
    if (kind !== "text" && kind !== "image")
      throw new Error(`${path}.input must be a list of text and image`);
    if (!input.includes(kind)) input.push(kind);
  }
  if (!input.includes("text")) throw new Error(`${path}.input must include text`);
  return {
    id,
    name: raw.name === undefined ? id : text(raw.name, `${path}.name`),
    contextWindow,
    maxTokens,
    reasoning: raw.reasoning === true,
    input,
  };
}

function parseDirect(raw: Obj, url: URL, path: string): { cidr: string; port: number } {
  if (raw.egress === undefined)
    throw new Error(
      `${path}.egress is required for a direct provider: the chart opens exactly that`,
    );
  const egress = object(raw.egress, `${path}.egress`);
  knownKeys(egress, new Set(["cidr", "port"]), `${path}.egress`);
  const cidr = text(egress.cidr, `${path}.egress.cidr`);
  const range = cidrRange(cidr);
  if (range === undefined)
    throw new Error(`${path}.egress.cidr must be an IPv4 CIDR like 192.168.7.101/32`);
  const forbidden = overlapsForbidden(range);
  if (forbidden !== undefined)
    throw new Error(
      `${path}.egress.cidr overlaps ${forbidden}, which a direct provider may not use`,
    );
  const port = count(egress.port, `${path}.egress.port`);
  if (port > 65535) throw new Error(`${path}.egress.port must be a port number`);
  if (port !== urlPort(url)) throw new Error(`${path}.egress.port must be the port of baseUrl`);
  const host = hostOf(url);
  if (host === "localhost" || host.endsWith(".localhost"))
    throw new Error(`${path}.baseUrl must not be a loopback address`);
  if (isIP(host) === 6) throw new Error(`${path}.baseUrl must be an IPv4 address or a host name`);
  if (isIP(host) === 4) {
    const address = ipv4ToInt(host);
    if (address === undefined) throw new Error(`${path}.baseUrl is not an IPv4 address`);
    if (overlapsForbidden({ first: address, last: address }) !== undefined)
      throw new Error(`${path}.baseUrl is in a range a direct provider may not use`);
    if (address < range.first || address > range.last)
      throw new Error(`${path}.baseUrl is outside egress.cidr`);
  }
  return { cidr, port };
}

function checkGatewayUrl(url: URL, path: string): void {
  if (url.protocol !== "https:")
    throw new Error(`${path}.baseUrl must be https:// for a provider that goes through OneCLI`);
  // The gateway matches a secret by host name; an address would also read as a cluster or LAN address to NO_PROXY.
  if (isIP(hostOf(url)) !== 0)
    throw new Error(
      `${path}.baseUrl must use a host name, not an IP address (OneCLI matches the host name)`,
    );
}

/**
 * Parses `PI_CUSTOM_MODEL_PROVIDERS`. Throws naming the field, never echoing the input, so a bad value fails the start
 * instead of the first request. Unset or empty: no providers.
 */
export function parseCustomProviders(
  source: string | undefined,
  reserved: ReadonlySet<string> = reservedProviderIds(),
): CustomProvider[] {
  if (source === undefined || source.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    // The parser's message can quote the input, so it is not passed on.
    throw new Error(`${CUSTOM_PROVIDERS_ENV} is not valid JSON`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${CUSTOM_PROVIDERS_ENV} must be a list`);
  const providers: CustomProvider[] = [];
  const ids = new Set<string>();
  (parsed as unknown[]).forEach((entry, index) => {
    const path = `customProviders[${String(index)}]`;
    const raw = object(entry, path);
    knownKeys(raw, PROVIDER_KEYS, path);
    const id = text(raw.id, `${path}.id`);
    if (!PROVIDER_ID.test(id)) throw new Error(`${path}.id must match ${PROVIDER_ID.source}`);
    if (reserved.has(id)) throw new Error(`${path}.id ${id} is a builtin provider`);
    if (ids.has(id)) throw new Error(`${path}.id ${id} is defined twice`);
    ids.add(id);
    const url = parseBaseUrl(raw.baseUrl, `${path}.baseUrl`);
    const via: unknown = raw.via ?? "onecli";
    if (via !== "onecli" && via !== "direct")
      throw new Error(`${path}.via must be onecli or direct`);
    let egress: CustomProvider["egress"];
    if (via === "direct") {
      egress = parseDirect(raw, url, path);
    } else {
      if (raw.egress !== undefined)
        throw new Error(
          `${path}.egress is for a direct provider; OneCLI traffic uses the gateway rule`,
        );
      checkGatewayUrl(url, path);
    }
    if (!Array.isArray(raw.models) || raw.models.length === 0)
      throw new Error(`${path}.models must list at least one model`);
    const models = (raw.models as unknown[]).map((item, at) =>
      parseModel(item, `${path}.models[${String(at)}]`),
    );
    const modelIds = new Set<string>();
    for (const found of models) {
      if (modelIds.has(found.id)) throw new Error(`${path}.models: ${found.id} is defined twice`);
      modelIds.add(found.id);
    }
    providers.push({
      id,
      // No trailing slash: pi-ai appends `/chat/completions`.
      baseUrl: url.href.replace(/\/+$/, ""),
      via,
      ...(egress === undefined ? {} : { egress }),
      compat: parseCompat(raw.compat, `${path}.compat`),
      models,
    });
  });
  return providers;
}

/**
 * `fetch` of a direct provider: no gateway, no redirect (one could lead anywhere the chart did not open), and only to
 * the origin of the provider's own base URL.
 */
export function directFetch(
  provider: Pick<CustomProvider, "baseUrl">,
  inner: FetchFunction,
): FetchFunction {
  const origin = new URL(provider.baseUrl).origin;
  return (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.origin !== origin)
      return Promise.reject(new Error(`a direct provider may only call ${origin}`));
    return inner(input, { ...init, redirect: "error" });
  };
}
