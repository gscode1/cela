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
      // No pty: a terminal would merge stderr into stdout and mangle binary bytes.
      const handle = await sandbox.commands.start(command, args, {
        onStdout: (chunk) => {
          handlers.onStdout(chunk);
        },
        onStderr: (chunk) => {
          handlers.onStderr(chunk);
        },
      });
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
