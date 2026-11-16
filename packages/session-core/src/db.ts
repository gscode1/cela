import pg from "pg";

/**
 * A pool against the CloudNativePG `-rw` service. Session-mode connections only: LISTEN and advisory
 * locks do not survive a transaction-pooled proxy. Keepalive and the statement timeout turn a silent
 * network drop into an error instead of a hang.
 */
export function createPool(databaseUrl: string, applicationName: string, max: number): pg.Pool {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    application_name: applicationName,
    max,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    statement_timeout: 30_000,
    query_timeout: 35_000,
  });
  // An idle client that the server dropped emits 'error'; without a handler that would crash the process.
  pool.on("error", () => undefined);
  return pool;
}
