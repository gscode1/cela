import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectionOptions, loadDatabaseTls } from "../src/db-tls.js";

const URL_ = "postgres://u:s3cret@db.example:5432/app";
let dir: string;
let ca: string;
let cert: string;
let key: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "db-tls-"));
  ca = join(dir, "ca.crt");
  cert = join(dir, "tls.crt");
  key = join(dir, "tls.key");
  writeFileSync(ca, "CA-PEM");
  writeFileSync(cert, "CERT-PEM");
  writeFileSync(key, "KEY-PEM");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** What the pg client ends up using, after pg merged the URI over the options. */
const effectiveSsl = (url: string, tls: Parameters<typeof connectionOptions>[1]): unknown =>
  (
    new pg.Client(connectionOptions(url, tls)) as unknown as {
      connectionParameters: { ssl: unknown };
    }
  ).connectionParameters.ssl;

const messageOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    return (err as Error).message;
  }
  return "";
};

describe("loadDatabaseTls", () => {
  it("is undefined when the mode is unset", () => {
    expect(loadDatabaseTls({})).toBeUndefined();
    expect(loadDatabaseTls({ PI_DURABLE_DATABASE_TLS_MODE: "" })).toBeUndefined();
  });
  it("rejects files without a mode, unknown modes and require", () => {
    expect(() => loadDatabaseTls({ PI_DURABLE_DATABASE_TLS_CA_FILE: ca })).toThrow(/is not/);
    expect(() => loadDatabaseTls({ PI_DURABLE_DATABASE_TLS_MODE: "require" })).toThrow(
      /must be one of/,
    );
    expect(() => loadDatabaseTls({ PI_DURABLE_DATABASE_TLS_MODE: "verify-ca" })).toThrow(
      /CA_FILE is required/,
    );
    expect(() =>
      loadDatabaseTls({
        PI_DURABLE_DATABASE_TLS_MODE: "disable",
        PI_DURABLE_DATABASE_TLS_CA_FILE: ca,
      }),
    ).toThrow(/is disable/);
  });
  it("needs the client cert and key together", () => {
    expect(() =>
      loadDatabaseTls({
        PI_DURABLE_DATABASE_TLS_MODE: "verify-full",
        PI_DURABLE_DATABASE_TLS_CERT_FILE: cert,
      }),
    ).toThrow(/together/);
  });
  it("reads every setting", () => {
    expect(
      loadDatabaseTls({
        PI_DURABLE_DATABASE_TLS_MODE: "verify-full",
        PI_DURABLE_DATABASE_TLS_CA_FILE: ca,
        PI_DURABLE_DATABASE_TLS_CERT_FILE: cert,
        PI_DURABLE_DATABASE_TLS_KEY_FILE: key,
      }),
    ).toEqual({ mode: "verify-full", caFile: ca, certFile: cert, keyFile: key });
  });
});

describe("connectionOptions", () => {
  it("leaves the URI alone and sets no ssl without settings", () => {
    const withMode = `${URL_}?sslmode=require`;
    expect(connectionOptions(withMode, undefined)).toEqual({ connectionString: withMode });
  });
  it("disable forces ssl off even against PGSSLMODE and a matching URI", () => {
    process.env.PGSSLMODE = "require";
    try {
      expect(effectiveSsl(URL_, { mode: "disable" })).toBe(false);
      expect(effectiveSsl(`${URL_}?sslmode=disable`, { mode: "disable" })).toBe(false);
    } finally {
      delete process.env.PGSSLMODE;
    }
  });
  it("verify-full verifies chain and host name against the CA", () => {
    expect(effectiveSsl(URL_, { mode: "verify-full", caFile: ca })).toEqual({
      ca: "CA-PEM",
      rejectUnauthorized: true,
    });
  });
  it("verify-full without a CA uses the system roots", () => {
    expect(effectiveSsl(URL_, { mode: "verify-full" })).toEqual({ rejectUnauthorized: true });
  });
  it("verify-ca verifies the chain but not the name", () => {
    const ssl = effectiveSsl(URL_, { mode: "verify-ca", caFile: ca }) as {
      rejectUnauthorized: boolean;
      checkServerIdentity: () => unknown;
    };
    expect(ssl.rejectUnauthorized).toBe(true);
    expect(ssl.checkServerIdentity()).toBeUndefined();
  });
  it("passes the client certificate and key", () => {
    const ssl = connectionOptions(URL_, {
      mode: "verify-full",
      caFile: ca,
      certFile: cert,
      keyFile: key,
    }).ssl as { cert: string; key: string };
    expect([ssl.cert, ssl.key]).toEqual(["CERT-PEM", "KEY-PEM"]);
  });
  it("strips an agreeing sslmode from the URI so pg cannot override the settings", () => {
    const out = connectionOptions(`${URL_}?sslmode=verify-full&application_name=x`, {
      mode: "verify-full",
      caFile: ca,
    });
    expect(out.connectionString).toBe(`${URL_}?application_name=x`);
    expect(
      effectiveSsl(`${URL_}?sslmode=verify-full`, { mode: "verify-full", caFile: ca }),
    ).toMatchObject({ ca: "CA-PEM", rejectUnauthorized: true });
  });
  it("rejects a URI sslmode that disagrees, without printing the URI", () => {
    for (const uriMode of ["require", "no-verify", "disable", "verify-ca"]) {
      const message = messageOf(() =>
        connectionOptions(`${URL_}?sslmode=${uriMode}`, { mode: "verify-full", caFile: ca }),
      );
      expect(message).toContain(`sslmode=${uriMode}`);
      expect(message).not.toContain("s3cret");
    }
  });
  it("rejects certificate parameters in the URI", () => {
    expect(() =>
      connectionOptions(`${URL_}?sslrootcert=/x`, { mode: "verify-full", caFile: ca }),
    ).toThrow(/sslrootcert/);
    expect(() => connectionOptions(`${URL_}?ssl=true`, { mode: "disable" })).toThrow(/ssl/);
  });
  it("names the variable and path of a missing file, never the URI", () => {
    const message = messageOf(() =>
      connectionOptions(URL_, { mode: "verify-full", caFile: join(dir, "missing.crt") }),
    );
    expect(message).toContain("PI_DURABLE_DATABASE_TLS_CA_FILE");
    expect(message).toContain("missing.crt");
    expect(message).toContain("ENOENT");
    expect(message).not.toContain("s3cret");
  });
  it("rejects an unparsable URI without echoing it", () => {
    expect(messageOf(() => connectionOptions("not a url s3cret", { mode: "disable" }))).toMatch(
      /not a valid URL$/,
    );
  });
});
