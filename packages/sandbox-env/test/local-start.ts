import { spawn } from "node:child_process";
import { once } from "node:events";
import type { Readable } from "node:stream";
import type { OutputHandlers, RemoteProcess, StartProcess } from "../src/bridge.ts";

/** A fake `start` that runs the command as a local process, standing in for sandboxd. */
export function localStart(overrides?: {
  command?: string;
  args?: readonly string[];
  write?: (data: Uint8Array, real: () => Promise<void>, call: number) => Promise<void>;
  onClose?: () => void;
}): StartProcess {
  return (command: string, args: readonly string[], handlers: OutputHandlers) => {
    const child = spawn(overrides?.command ?? command, [...(overrides?.args ?? args)], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Like sandbox-client: read on only once the handler let the chunk go, so back-pressure reaches the process.
    const forward = (stream: Readable, handler: (chunk: Uint8Array) => Promise<void>): void => {
      stream.on("data", (chunk: Buffer) => {
        stream.pause();
        void handler(chunk).finally(() => stream.resume());
      });
    };
    forward(child.stdout, (chunk) => handlers.onStdout(chunk));
    forward(child.stderr, (chunk) => handlers.onStderr(chunk));
    child.stdin.on("error", () => undefined);
    const closed = new Promise<{ exitCode: number }>((resolve) =>
      // "close" fires after stdio ended, so every stdout chunk was delivered first, as in sandboxd.
      child.once("close", (code, signal) => resolve({ exitCode: code ?? (signal ? -1 : 0) })),
    );
    let calls = 0;
    const realWrite = (data: Uint8Array): Promise<void> =>
      new Promise((resolve, reject) =>
        child.stdin.write(data, (error) => (error ? reject(error) : resolve())),
      );
    const proc: RemoteProcess = {
      write: (data) => {
        const call = ++calls;
        return overrides?.write
          ? overrides.write(data, () => realWrite(data), call)
          : realWrite(data);
      },
      closeStdin: () => {
        child.stdin.end();
        return Promise.resolve();
      },
      wait: () => closed,
      close: async () => {
        overrides?.onClose?.();
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          await once(child, "close");
        }
      },
    };
    return Promise.resolve(proc);
  };
}
