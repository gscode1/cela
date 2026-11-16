/** A repository workspace requested at session creation. `branch` absent: the repository's default branch. */
export interface RepoSpec {
  /** `owner/name` on github.com. */
  repo: string;
  branch?: string;
}

// GitHub owners are 1-39 characters of letters, digits and single hyphens; names are up to 100 characters of
// letters, digits, `.`, `_` and `-`. The first pattern is the contract; the length caps and the checks below
// close what a character class cannot (`..`, `.git`, a leading dash that git would read as an option).
const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** Returns an error message, or undefined when `repo` is acceptable. */
export function repoError(repo: string): string | undefined {
  if (repo.length > 140 || !REPO.test(repo)) return "repo must look like owner/name";
  const [owner = "", name = ""] = repo.split("/");
  if (owner.length > 39 || owner.startsWith("-") || owner.endsWith("-")) {
    return "repo owner is not a valid GitHub account name";
  }
  if (repo.includes("..") || name === "." || name.startsWith("-")) {
    return "repo must not contain '..' or start a name with '-'";
  }
  if (name.length > 100 || name.toLowerCase().endsWith(".git")) {
    return "repo name must not end in .git";
  }
  return undefined;
}

/** Returns an error message, or undefined when `branch` is acceptable as a git ref name to clone. */
export function branchError(branch: string): string | undefined {
  if (branch.length > 200 || !REF.test(branch)) return "branch is not a valid ref name";
  if (
    branch.includes("..") ||
    branch.includes("//") ||
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    branch.endsWith(".lock") ||
    branch.includes("/.")
  ) {
    return "branch is not a valid ref name";
  }
  return undefined;
}

/**
 * Validates the optional `{ repo, branch }` of `POST /sessions`. `undefined` means no repository was asked for;
 * a string is the 400 message. Only `owner/name` on github.com over https exists: no URL is accepted anywhere,
 * the orchestrator builds `https://github.com/<repo>.git` itself.
 */
export function chooseRepo(body: Record<string, unknown>): RepoSpec | string | undefined {
  const { repo, branch } = body;
  if (repo === undefined) return branch === undefined ? undefined : "branch needs a repo";
  if (typeof repo !== "string") return "repo must be a string like owner/name";
  const bad = repoError(repo);
  if (bad !== undefined) return bad;
  if (branch === undefined) return { repo };
  if (typeof branch !== "string") return "branch must be a string";
  const badBranch = branchError(branch);
  if (badBranch !== undefined) return badBranch;
  return { repo, branch };
}

/** The https clone URL of a validated repo. Credentials never appear in it: the OneCLI gateway injects them. */
export function cloneUrl(repo: string, base = "https://github.com"): string {
  return `${base}/${repo}.git`;
}
