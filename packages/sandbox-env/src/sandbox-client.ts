// The only module allowed to import the vendored Agent Sandbox SDK (see packages/vendor).
import { SandboxClient } from "agentic-sandbox-client";
import type { RemoteProcess, StartProcess } from "./bridge.js";

export type Connectivity = "in-cluster-service" | "in-cluster-pod-ip" | "port-forward";

export interface SandboxTarget {
  claimName: string;
  namespace: string;
  connectivity: Connectivity;
  /** Bearer token for sandboxd; plaintext on the wire with the in-cluster modes. */
  authToken?: string;
}

/** Looks the SandboxClaim up on first use, so constructing this does no I/O. */
export function sandboxStart(target: SandboxTarget): StartProcess {
  return async (command, args, handlers) => {
    const client = new SandboxClient({
      namespace: target.namespace,
      sandboxd: {
        connectivity: target.connectivity,
        ...(target.authToken === undefined ? {} : { authToken: target.authToken }),
      },
    });
    // Release the handle with closeLocal(): Sandbox.close() also DELETES the SandboxClaim, which
    // would destroy the session's sandbox (and its PVC) every time a bridge exits.
    const sandbox = await client.getSandbox(target.claimName, target.namespace);
    try {
      // No pty: a terminal would merge stderr into stdout and mangle binary bytes. No output callbacks either: the SDK
      // calls them as fast as sandboxd sends, while `events` reads only when pulled, so awaiting each handler holds
      // sandboxd's pipe (and the process) back while our reader is slow, instead of queuing in the orchestrator.
      const handle = await sandbox.commands.start(command, args);
      const pumped = (async (): Promise<void> => {
        for await (const event of handle.events) {
          if (event.type === "stdout") await handlers.onStdout(event.data);
          else if (event.type === "stderr") await handlers.onStderr(event.data);
        }
      })();
      // A lost stream also rejects wait(), which is where the bridge sees it.
      pumped.catch(() => undefined);
      const process: RemoteProcess = {
        write: (data) => handle.write(data),
        closeStdin: () => handle.closeStdin(),
        wait: () => handle.wait(),
        close: async () => {
          await handle.close();
          await sandbox.closeLocal();
        },
      };
      return process;
    } catch (error) {
      await sandbox.closeLocal();
      throw error;
    }
  };
}

/**
 * Waits until the claim's Sandbox is Ready again (the SDK's own wait, 180 s by default), e.g. after its Pod was replaced.
 * Rejects when the claim is gone or the wait times out.
 */
export async function waitSandboxReady(target: SandboxTarget): Promise<void> {
  const client = new SandboxClient({
    namespace: target.namespace,
    sandboxd: {
      connectivity: target.connectivity,
      ...(target.authToken === undefined ? {} : { authToken: target.authToken }),
    },
  });
  const sandbox = await client.getSandbox(target.claimName, target.namespace);
  await sandbox.closeLocal();
}

export interface ClaimRequest extends SandboxTarget {
  /** SandboxWarmPool the claim references; a pool with `replicas: 0` is a plain template alias. */
  warmPool: string;
}

/**
 * Creates the named SandboxClaim, or adopts it when it exists (create-or-attach, so a restarted
 * orchestrator calls it again for every session), and waits until its Sandbox is ready. The handle is
 * released with closeLocal(): only session deletion may delete a claim, and this module has no delete.
 */
export async function ensureClaim(request: ClaimRequest): Promise<void> {
  const client = new SandboxClient({
    namespace: request.namespace,
    sandboxd: {
      connectivity: request.connectivity,
      ...(request.authToken === undefined ? {} : { authToken: request.authToken }),
    },
  });
  const sandbox = await client.createSandbox(request.warmPool, request.namespace, {
    claimName: request.claimName,
    adoptExisting: true,
  });
  await sandbox.closeLocal();
}
