import { createPublicKey, createVerify, generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GithubDeniedError,
  loadGithubApp,
  mintInstallationToken,
  signAppJwt,
  TOKEN_PERMISSIONS,
} from "../src/github-app.ts";
import type { FetchLike, GithubApp } from "../src/github-app.ts";
import { Redacted } from "../src/onecli.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const app: GithubApp = {
  appId: "123456",
  installationId: "7890123",
  privateKey: new Redacted(privateKey),
};
const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("signAppJwt", () => {
  it("is an RS256 JWT with the App id as iss, valid under 10 minutes, verifiable with the public key", () => {
    const jwt = signAppJwt(app, NOW);
    const [header, payload, signature] = jwt.split(".") as [string, string, string];
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
      iss: string;
      iat: number;
      exp: number;
    };
    expect(claims.iss).toBe("123456");
    expect(claims.iat).toBe(NOW / 1000 - 60);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(10 * 60);
    expect(claims.exp).toBeGreaterThan(NOW / 1000);
    const ok = createVerify("RSA-SHA256")
      .update(`${header}.${payload}`)
      .verify(createPublicKey(publicKey), Buffer.from(signature, "base64url"));
    expect(ok).toBe(true);
  });
});

describe("loadGithubApp", () => {
  it("reads the mounted secret files and keeps the key out of string conversion", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gh-app-"));
    dirs.push(dir);
    await writeFile(join(dir, "app-id"), "123456\n");
    await writeFile(join(dir, "installation-id"), "7890123\n");
    await writeFile(join(dir, "private-key.pem"), privateKey);
    const loaded = await loadGithubApp(dir);
    expect(loaded.appId).toBe("123456");
    expect(loaded.installationId).toBe("7890123");
    expect(`${String(loaded.privateKey)} ${JSON.stringify(loaded)}`).not.toContain("PRIVATE KEY");
  });

  it("names the missing file and rejects non-numeric ids", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gh-app-"));
    dirs.push(dir);
    await expect(loadGithubApp(dir)).rejects.toThrow(
      /app-id, installation-id, private-key\.pem are missing/,
    );
    await writeFile(join(dir, "app-id"), "1");
    await writeFile(join(dir, "installation-id"), "1");
    await expect(loadGithubApp(dir)).rejects.toThrow(/private-key\.pem is missing/);
    await writeFile(join(dir, "app-id"), "not-a-number");
    await writeFile(join(dir, "installation-id"), "1");
    await writeFile(join(dir, "private-key.pem"), "k");
    await expect(loadGithubApp(dir)).rejects.toThrow(/numeric/);
  });
});

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function github(
  status: number,
  body: unknown,
  sent: Sent[] = [],
  headers: Record<string, string> = {},
): FetchLike {
  return (url, init) => {
    sent.push({
      url,
      method: init.method,
      headers: init.headers,
      body: JSON.parse(init.body ?? "{}") as Record<string, unknown>,
    });
    return Promise.resolve({
      status,
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    });
  };
}

const granted = (full: string) => ({
  token: "ghs_secrettokenvalue",
  expires_at: "2026-11-15T13:00:00Z",
  repository_selection: "selected",
  repositories: [{ full_name: full }],
});

describe("mintInstallationToken", () => {
  it("asks for one repository and minimal permissions, with the App JWT", async () => {
    const sent: Sent[] = [];
    const minted = await mintInstallationToken(
      app,
      "Octo/Hello",
      github(201, granted("octo/hello"), sent),
      NOW,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]?.method).toBe("POST");
    expect(sent[0]?.url).toBe("https://api.github.com/app/installations/7890123/access_tokens");
    expect(sent[0]?.body).toEqual({
      repositories: ["Hello"],
      permissions: { contents: "write", pull_requests: "write", metadata: "read" },
    });
    expect(TOKEN_PERMISSIONS).toEqual(sent[0]?.body.permissions);
    expect(sent[0]?.headers.authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(minted.token.reveal()).toBe("ghs_secrettokenvalue");
    expect(minted.expiresAt.toISOString()).toBe("2026-11-15T13:00:00.000Z");
    expect(JSON.stringify(minted)).not.toContain("ghs_");
  });

  it("refuses a token that covers another repository or more than one", async () => {
    await expect(
      mintInstallationToken(app, "octo/hello", github(201, granted("someone-else/hello")), NOW),
    ).rejects.toBeInstanceOf(GithubDeniedError);
    const wide = {
      ...granted("octo/hello"),
      repositories: [{ full_name: "octo/hello" }, { full_name: "octo/b" }],
    };
    await expect(mintInstallationToken(app, "octo/hello", github(201, wide), NOW)).rejects.toThrow(
      /exactly that repository/,
    );
    const none = { ...granted("octo/hello"), repositories: undefined };
    await expect(mintInstallationToken(app, "octo/hello", github(201, none), NOW)).rejects.toThrow(
      /0 repositories/,
    );
  });

  it("treats GitHub rate limiting as retryable, whatever status carries it", async () => {
    const limited: [number, unknown, Record<string, string>][] = [
      [429, { message: "slow down" }, {}],
      [403, { message: "Forbidden" }, { "x-ratelimit-remaining": "0" }],
      [403, { message: "Forbidden" }, { "retry-after": "30" }],
      [403, { message: "You have exceeded a secondary rate limit." }, {}],
    ];
    for (const [status, body, headers] of limited) {
      const error = await mintInstallationToken(
        app,
        "octo/hello",
        github(status, body, [], headers),
        NOW,
      ).catch((e: unknown) => e as Error);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(GithubDeniedError);
    }
  });

  it("classifies answers: 404 and 422 are final, 5xx can be retried, and no message holds a secret", async () => {
    for (const status of [401, 403, 404, 422]) {
      await expect(
        mintInstallationToken(app, "octo/hello", github(status, { message: "Not Found" }), NOW),
      ).rejects.toBeInstanceOf(GithubDeniedError);
    }
    const error = await mintInstallationToken(
      app,
      "octo/hello",
      github(502, { message: "bad gateway" }),
      NOW,
    ).catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(GithubDeniedError);
    expect((error as Error).message).not.toContain("PRIVATE KEY");
  });
});
