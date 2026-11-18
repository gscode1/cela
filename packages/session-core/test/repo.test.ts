import { describe, expect, it } from "vitest";
import {
  branchError,
  chooseRepo,
  cloneUrl,
  repoAllowed,
  repoError,
  repoPatternError,
} from "../src/repo.ts";

describe("repoError", () => {
  it("accepts owner/name", () => {
    for (const repo of ["octo/hello", "my-org/my.repo_1", "A1/b-c", "octo/.github"]) {
      expect(repoError(repo), repo).toBeUndefined();
    }
  });

  it("rejects anything else, in particular URLs, traversal and option-like names", () => {
    const bad = [
      "",
      "octo",
      "octo/",
      "/hello",
      "octo/hello/extra",
      "https://github.com/octo/hello",
      "git@github.com:octo/hello",
      "octo/hello.git",
      "octo/HELLO.GIT",
      "octo/..",
      "octo/a..b",
      "../hello",
      "octo/-rf",
      "-octo/hello",
      "octo-/hello",
      "octo/hel lo",
      "octo/hello\n",
      "octo/he;llo",
      "octo/he$(x)",
      "x".repeat(40) + "/hello",
      "octo/" + "n".repeat(101),
    ];
    for (const repo of bad) expect(repoError(repo), JSON.stringify(repo)).toBeDefined();
  });
});

describe("branchError", () => {
  it("accepts usual branch names", () => {
    for (const branch of ["main", "feature/x-1", "release-1.2.3", "pi/test_branch", "v1"]) {
      expect(branchError(branch), branch).toBeUndefined();
    }
  });

  it("rejects options, traversal, whitespace and git-invalid refs", () => {
    const bad = [
      "",
      "-main",
      "--upload-pack=x",
      "a..b",
      "a//b",
      "a/",
      "a.",
      "a.lock",
      "feature.lock/foo",
      "a/b.lock/c",
      "a/.hidden",
      "a b",
      "a~1",
      "a^",
      "a:b",
      "a?b",
      "a*b",
      "a[b",
      "a\\b",
      "a@{1}",
      "/a",
      "n".repeat(201),
    ];
    for (const branch of bad) expect(branchError(branch), JSON.stringify(branch)).toBeDefined();
  });
});

describe("chooseRepo", () => {
  it("returns undefined without a repo, so nothing changes for a plain session", () => {
    expect(chooseRepo({})).toBeUndefined();
    expect(chooseRepo({ provider: "scripted", model: "scripted-1" })).toBeUndefined();
  });

  it("returns the validated spec, with the branch only when given", () => {
    expect(chooseRepo({ repo: "octo/hello" })).toEqual({ repo: "octo/hello" });
    expect(chooseRepo({ repo: "octo/hello", branch: "dev" })).toEqual({
      repo: "octo/hello",
      branch: "dev",
    });
  });

  it("returns the 400 message for a bad shape", () => {
    expect(chooseRepo({ branch: "dev" })).toMatch(/needs a repo/);
    expect(chooseRepo({ repo: 5 })).toMatch(/must be a string/);
    expect(chooseRepo({ repo: "octo/hello", branch: 5 })).toMatch(/branch must be a string/);
    expect(chooseRepo({ repo: "octo/hello", branch: "--x" })).toMatch(/not a valid ref/);
    expect(chooseRepo({ repo: "http://evil/x" })).toMatch(/owner\/name/);
    expect(chooseRepo({ repo: null })).toMatch(/must be a string/);
  });
});

describe("cloneUrl", () => {
  it("is https on github.com and carries no credentials", () => {
    expect(cloneUrl("octo/hello")).toBe("https://github.com/octo/hello.git");
  });
});

describe("repoPatternError", () => {
  it("accepts *, owner/* and owner/name", () => {
    for (const pattern of ["*", "octo/*", "Octo/Hello", "my-org/my.repo_1"]) {
      expect(repoPatternError(pattern), pattern).toBeUndefined();
    }
  });

  it("rejects partial wildcards, URLs and anything repoError refuses", () => {
    for (const pattern of [
      "",
      "*/*",
      "*/hello",
      "octo/hel*",
      "octo/**",
      "octo",
      "-octo/*",
      "https://github.com/octo/*",
    ]) {
      expect(repoPatternError(pattern), pattern).toMatch(/not \*, owner\/\* or owner\/name/);
    }
  });
});

describe("repoAllowed", () => {
  it("refuses everything with an empty list", () => {
    expect(repoAllowed("octo/hello", [])).toBe(false);
  });

  it("matches *, the owner's wildcard and the exact name, ignoring case", () => {
    expect(repoAllowed("octo/hello", ["*"])).toBe(true);
    expect(repoAllowed("Octo/Hello", ["octo/*"])).toBe(true);
    expect(repoAllowed("octo/hello", ["OCTO/HELLO"])).toBe(true);
  });

  it("does not match another owner, a prefix of the owner or another repository", () => {
    expect(repoAllowed("octo/hello", ["octo/hell"])).toBe(false);
    expect(repoAllowed("octo/hello", ["oct/*"])).toBe(false);
    expect(repoAllowed("octocat/hello", ["octo/*"])).toBe(false);
    expect(repoAllowed("other/hello", ["octo/hello", "octo/*"])).toBe(false);
  });
});
