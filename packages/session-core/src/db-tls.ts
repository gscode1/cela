import { readFileSync } from "node:fs";

/**
 * TLS towards Postgres, shared by every pool (ingest, the orchestrator's inbox pool, the schema probe and the
 * Pi Durable adapter's pinned connection).
 *
 * `require` (encrypt, trust whatever answers) is deliberately not a mode: it protects against passive sniffing only and
 * would let a quiet "TLS is on" hide that nothing is verified. Use `verify-ca` when the server certificate has no
 * name that matches the host, `verify-full` otherwise.
 */
export const DATABASE_TLS_MODES = ["disable", "verify-ca", "verify-full"] as const;
export type DatabaseTlsMode = (typeof DATABASE_TLS_MODES)[number];

export interface DatabaseTls {
  mode: DatabaseTlsMode;
  /** PEM bundle that signed the server certificate. Required for `verify-ca`; `verify-full` falls back to the system roots. */
  caFile?: string;
  /** Client certificate and key (mutual TLS), both or neither. */
  certFile?: string;
  keyFile?: string;
}

/** What `pg.Pool` takes from us. `ssl` is always set when TLS is configured, so `PGSSLMODE` cannot reach the client. */
export interface DatabaseConnection {
  connectionString: string;
  ssl?:
    | false
    | {
        ca?: string;
        cert?: string;
        key?: string;
        rejectUnauthorized: true;
        checkServerIdentity?: () => undefined;
      };
}

const MODE_VAR = "PI_DURABLE_DATABASE_TLS_MODE";
const CA_VAR = "PI_DURABLE_DATABASE_TLS_CA_FILE";
const CERT_VAR = "PI_DURABLE_DATABASE_TLS_CERT_FILE";
const KEY_VAR = "PI_DURABLE_DATABASE_TLS_KEY_FILE";

/**
 * Reads the TLS settings from the environment. Returns `undefined` when the mode is unset: then nothing here touches the
 * connection string, which keeps its own `sslmode` semantics (what a plain install does today).
 */
export function loadDatabaseTls(
  env: Readonly<Record<string, string | undefined>>,
): DatabaseTls | undefined {
  const mode = env[MODE_VAR];
  if (mode === undefined || mode === "") {
    for (const name of [CA_VAR, CERT_VAR, KEY_VAR])
      if (env[name]) throw new Error(`${name} is set but ${MODE_VAR} is not`);
    return undefined;
  }
  if (!(DATABASE_TLS_MODES as readonly string[]).includes(mode))
    throw new Error(`${MODE_VAR} must be one of ${DATABASE_TLS_MODES.join(", ")} (got "${mode}")`);
  const tls: DatabaseTls = { mode: mode as DatabaseTlsMode };
  const caFile = env[CA_VAR];
  const certFile = env[CERT_VAR];
  const keyFile = env[KEY_VAR];
  if (mode === "disable") {
    for (const name of [CA_VAR, CERT_VAR, KEY_VAR])
      if (env[name]) throw new Error(`${name} is set but ${MODE_VAR} is disable`);
    return tls;
  }
  if (mode === "verify-ca" && !caFile)
    throw new Error(`${CA_VAR} is required when ${MODE_VAR} is verify-ca`);
  if (Boolean(certFile) !== Boolean(keyFile))
    throw new Error(`${CERT_VAR} and ${KEY_VAR} must be set together`);
  if (caFile) tls.caFile = caFile;
  if (certFile && keyFile) {
    tls.certFile = certFile;
    tls.keyFile = keyFile;
  }
  return tls;
}

/** Parameters that would put certificate material or a protocol choice in the URI, next to our own settings. */
const URI_TLS_FILES = ["sslrootcert", "sslcert", "sslkey", "sslcrl", "sslnegotiation", "ssl"];

function readPem(file: string, variable: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "unreadable";
    throw new Error(`${variable}: cannot read ${file} (${code}); mount the Secret that holds it`, {
      cause: err,
    });
  }
}

/**
 * Turns the settings into pool options. Precedence:
 * - `tls` undefined: the URI is returned as is and `ssl` is left to `pg` (a `sslmode` in the URI, then `PGSSLMODE`).
 * - `tls` set: it alone decides. `pg` lets the URI override a given `ssl` object, so `sslmode` is stripped from the URI
 *   when it agrees with the mode and rejected when it does not; `sslrootcert`, `sslcert` and `sslkey` in the URI are rejected
 *   (use the settings), so two places can never disagree silently. Error messages never contain the URI.
 */
export function connectionOptions(
  databaseUrl: string,
  tls: DatabaseTls | undefined,
): DatabaseConnection {
  if (!tls) return { connectionString: databaseUrl };
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error("the database URI is not a valid URL");
  }
  let changed = false;
  const uriMode = url.searchParams.get("sslmode");
  if (uriMode !== null) {
    if (uriMode !== tls.mode)
      throw new Error(
        `the database URI says sslmode=${uriMode} but ${MODE_VAR} is ${tls.mode}; drop sslmode from the URI`,
      );
    url.searchParams.delete("sslmode");
    changed = true;
  }
  for (const name of URI_TLS_FILES)
    if (url.searchParams.has(name))
      throw new Error(
        `the database URI sets ${name}; use ${MODE_VAR} and the ${CA_VAR} family instead`,
      );
  if (url.searchParams.has("uselibpqcompat")) {
    url.searchParams.delete("uselibpqcompat");
    changed = true;
  }
  const connectionString = changed ? url.toString() : databaseUrl;
  if (tls.mode === "disable") return { connectionString, ssl: false };
  const ssl: NonNullable<Exclude<DatabaseConnection["ssl"], false>> = { rejectUnauthorized: true };
  if (tls.caFile) ssl.ca = readPem(tls.caFile, CA_VAR);
  if (tls.certFile && tls.keyFile) {
    ssl.cert = readPem(tls.certFile, CERT_VAR);
    ssl.key = readPem(tls.keyFile, KEY_VAR);
  }
  // verify-ca: the chain must verify, the host name need not match.
  if (tls.mode === "verify-ca") ssl.checkServerIdentity = () => undefined;
  return { connectionString, ssl };
}
