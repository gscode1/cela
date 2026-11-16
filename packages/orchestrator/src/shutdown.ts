import { log } from "./log.js";

/** What main() has started so far. Each part is set as soon as it exists, so a signal during startup sees it. */
export interface Running {
  inbox?: { stop(): Promise<void> };
  settings?: { stop(): Promise<void> };
  service?: { stop(): void };
  sweeper?: { stop(): void };
  /** The Harness host, once opened. */
  host?: { close(): Promise<void> };
  /** Set while `Host.open` runs: a signal in that window waits for it, then closes the host it produced. */
  opening?: Promise<{ close(): Promise<void> }>;
}

export interface ShutdownDeps {
  running: Running;
  stop: AbortController;
  server: { close(): unknown; closeAllConnections(): void };
  pool: { end(): Promise<void> };
  exit: (code: number) => void;
  /** Hard limit after which the process exits even if a part hangs. */
  forceAfterMs?: number;
}

/** The SIGTERM/SIGINT handler: stops what main() started, closes the host (also one still being opened), exits. */
export function createShutdown(deps: ShutdownDeps): (signal: string) => void {
  const { running, stop, server, pool, exit } = deps;
  return (signal) => {
    log("shutdown", { signal });
    stop.abort();
    server.close();
    void (async () => {
      running.service?.stop();
      running.sweeper?.stop();
      await running.inbox?.stop();
      await running.settings?.stop();
      const host = running.host ?? (await running.opening?.catch(() => undefined));
      await host?.close();
      server.closeAllConnections();
      await pool.end().catch(() => undefined);
    })().finally(() => {
      exit(0);
    });
    setTimeout(() => {
      exit(0);
    }, deps.forceAfterMs ?? 10_000).unref();
  };
}
