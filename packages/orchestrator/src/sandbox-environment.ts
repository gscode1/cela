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
      "git with git-lfs, gh, curl, jq, yq, ripgrep (rg), fd, tree, file, zip, unzip, xz, bzip2, sqlite3, shellcheck, node 22 with npm, npx and corepack (pnpm, yarn), python3 with pip and venv, uv and uvx, gcc and make",
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
  /** The rule sets of the session's profile snapshot (`egressRuleSets`); only meaningful while `network` is `proxied`. */
  egressRuleSets?: readonly string[];
}

/** The facts of a session; `proxyOn` is whether this deployment runs the egress proxy (ADR 0038 "Proxy disabled"). */
export function environmentFacts(
  session: SessionRow,
  proxyOn: boolean,
  egressRuleSets: readonly string[] = [],
): EnvironmentFacts {
  return {
    flavour: session.sandboxFlavour,
    repo: session.repo,
    network: proxyOn ? session.networkMode : "direct",
    egressRuleSets,
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
  // Names only, not their hosts: an operator edits a set's rules while the session runs, and the text must not change
  // under a running conversation (ADR 0049). The denial itself names the host (ADR 0052).
  const sets =
    (facts.egressRuleSets ?? []).length === 0
      ? "The session's profile names no egress rule set, so only the rule sets that apply to every session and rules added to this session open hosts."
      : `The session's profile names the egress rule sets ${(facts.egressRuleSets ?? []).join(", ")}.`;
  const network =
    facts.network === "proxied"
      ? `Network: HTTP and HTTPS only, through the proxy already set in HTTPS_PROXY; the session's egress rules decide which hosts answer. ${sets} A host no rule allows is refused with "407 Request rejected by proxy: <host> is not allowed by the session's egress rules": that is a rule, not a broken network, so do not retry it; say which host you need. No DNS, no UDP.`
      : "Network: direct internet access; private and cluster addresses are blocked.";
  return [
    "<sandbox_environment>",
    "Your tool commands run in an isolated Linux sandbox as user pi (uid 1000), without root.",
    "- Working directory: /workspace, a persistent volume. Everything outside it may be lost when the sandbox is suspended or replaced.",
    `- Writable: /workspace, /tmp and HOME (${SANDBOX_HOME}). Nothing can be installed with apt.`,
    `- Tools: ${tools}.`,
    `- ${repo}`,
    `- ${network}`,
    // The date is per message and added at each request (ADR 0057), so this line stays fixed.
    "- Date: each user message starts with <current_date>, the UTC date it was sent, which may be later than your training data. Run `date` for the exact time.",
    "</sandbox_environment>",
  ].join("\n");
}
