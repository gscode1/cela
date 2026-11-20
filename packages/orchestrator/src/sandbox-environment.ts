import type { NetworkMode, RepoSpec, SandboxFlavour, SessionRow } from "@cela/session-core";
import { REPO_DIR } from "./workspace.js";

/**
 * The facts about its sandbox that a session's agent gets in its instructions (docs/decisions/0049-sandbox-environment-
 * instructions.md). Facts only, no behaviour: what to do about them is the profile's business. Deterministic per session
 * (no tokens, addresses or timestamps), so the text never changes under a running conversation.
 */

/** The home of user `pi` (uid 1000) in both images, and their HOME. Pinned against the Dockerfiles by a test. */
export const SANDBOX_HOME = "/home/pi";

/** What each flavour's image ships, as the agent should read it. Pinned against the Dockerfiles by a test. */
export const FLAVOUR_FACTS: Readonly<Record<SandboxFlavour, { tools: string }>> = {
  default: {
    tools:
      "git, gh, curl, jq, unzip, node 22 with npm, npx and corepack (pnpm, yarn), python3 with pip and venv, gcc and make",
  },
  browser: {
    tools:
      "git, node 22, a headless Chromium with pi-browser, patchright-run and agent-browser (usage: /usr/local/share/pi-browser/BROWSER.md)",
  },
};

export interface EnvironmentFacts {
  flavour: SandboxFlavour;
  repo: RepoSpec | null;
  /** What the sandbox can reach: the session's mode, or `direct` when the deployment runs without the egress proxy. */
  network: NetworkMode;
}

/** The facts of a session; `proxyOn` is whether this deployment runs the egress proxy (ADR 0038 "Proxy disabled"). */
export function environmentFacts(session: SessionRow, proxyOn: boolean): EnvironmentFacts {
  return {
    flavour: session.sandboxFlavour,
    repo: session.repo,
    network: proxyOn ? session.networkMode : "direct",
  };
}

export function renderEnvironment(facts: EnvironmentFacts): string {
  const { tools } = FLAVOUR_FACTS[facts.flavour];
  const repo =
    facts.repo === null
      ? "Repository: none is checked out, and /workspace starts empty."
      : `Repository: ${facts.repo.repo}, cloned into ${REPO_DIR} from ${
          facts.repo.branch === undefined ? "its default branch" : `branch ${facts.repo.branch}`
        }. git and gh reach github.com for this repository only, already authenticated; no token is in the sandbox.`;
  const network =
    facts.network === "proxied"
      ? "Network: HTTP and HTTPS only, through the proxy already set in HTTPS_PROXY; the session's egress rules decide which hosts answer. No DNS, no UDP."
      : "Network: direct internet access; private and cluster addresses are blocked.";
  return [
    "<sandbox_environment>",
    "Your tool commands run in an isolated Linux sandbox as user pi (uid 1000), without root.",
    "- Working directory: /workspace, a persistent volume. Everything outside it may be lost when the sandbox is suspended or replaced.",
    `- Writable: /workspace, /tmp and HOME (${SANDBOX_HOME}). Nothing can be installed with apt.`,
    `- Tools: ${tools}.`,
    `- ${repo}`,
    `- ${network}`,
    "</sandbox_environment>",
  ].join("\n");
}
