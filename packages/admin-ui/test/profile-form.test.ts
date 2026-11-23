import { describe, expect, it } from "vitest";
import type { ProfileDefinition, SkillInfo } from "@/lib/api/profiles";
import type { SettingsValues } from "@/lib/api/settings";
import { diffDefinitions, diffSettings } from "@/lib/diff";
import {
  definitionFromForm,
  definitionProblems,
  executableSkillsWithoutBash,
  formFromDefinition,
  isEmptyForm,
  profileNameProblem,
  readProblems,
  referenceProblems,
  withoutBrokenReferences,
} from "@/lib/profile-form";
import { formFromValues, settingsProblems, valuesFromForm } from "@/lib/settings-form";

const roundTrip = (definition: ProfileDefinition): ProfileDefinition =>
  definitionFromForm(formFromDefinition(definition), definition);

describe("profile form round trips", () => {
  const cases: [string, ProfileDefinition][] = [
    ["empty", {}],
    ["omitted tools stay omitted", { instructions: "x" }],
    ["empty tools stay empty: no tools at all", { tools: [], modelTools: [] }],
    ["explicit lists", { tools: ["read", "bash"], modelTools: ["read"] }],
    ["explicit off", { reasoning: "off" }],
    [
      "every field",
      {
        tools: ["read"],
        modelTools: ["read"],
        instructions: "be brief",
        defaultModel: "scripted/scripted-2",
        reasoning: "xhigh",
        turnBudget: 12,
        tokenBudget: 2_000_000,
        mcpServers: ["docs"],
        skills: [{ name: "lint", version: 2, digest: "a".repeat(64) }],
        repoSkills: true,
        repoContext: true,
        sandboxSize: "m",
        sandboxSizes: ["l", "xl"],
      },
    ],
    [
      "explicit false and empty list spellings",
      { mcpServers: [], repoSkills: false, repoContext: false },
    ],
  ];
  for (const [name, definition] of cases) {
    it(`keeps ${name}`, () => {
      expect(roundTrip(definition)).toEqual(definition);
    });
  }

  it("keeps a token budget set through the API when the console saves an edit elsewhere", () => {
    const stored: ProfileDefinition = { instructions: "x", tokenBudget: 500_000 };
    const form = formFromDefinition(stored);
    expect(definitionFromForm({ ...form, instructions: "y" }, stored)).toEqual({
      instructions: "y",
      tokenBudget: 500_000,
    });
  });

  it("round-trips the network mode: proxied is left out, direct is sent, a stored spelling is kept", () => {
    expect(
      definitionFromForm(formFromDefinition({ instructions: "x" }), { instructions: "x" }),
    ).toEqual({
      instructions: "x",
    });
    const direct: ProfileDefinition = { instructions: "x", networkMode: "direct" };
    expect(definitionFromForm(formFromDefinition(direct), direct)).toEqual(direct);
    const explicit: ProfileDefinition = { networkMode: "proxied" };
    expect(definitionFromForm(formFromDefinition(explicit), explicit)).toEqual(explicit);
  });

  it("round-trips the sandbox flavour: default is left out, browser is sent, a stored spelling is kept", () => {
    const plain: ProfileDefinition = { instructions: "x" };
    expect(definitionFromForm(formFromDefinition(plain), plain)).toEqual(plain);
    const browser: ProfileDefinition = { sandboxFlavour: "browser" };
    expect(definitionFromForm(formFromDefinition(browser), browser)).toEqual(browser);
    const explicit: ProfileDefinition = { sandboxFlavour: "default" };
    expect(definitionFromForm(formFromDefinition(explicit), explicit)).toEqual(explicit);
  });

  it("round-trips the sandbox runtime: the default is left out, a named one is sent", () => {
    const plain: ProfileDefinition = { instructions: "x" };
    expect(formFromDefinition(plain).sandboxRuntime).toBe("");
    expect(definitionFromForm(formFromDefinition(plain), plain)).toEqual(plain);
    const named: ProfileDefinition = { sandboxRuntime: "runc" };
    expect(definitionFromForm(formFromDefinition(named), named)).toEqual(named);
    expect(definitionFromForm({ ...formFromDefinition(named), sandboxRuntime: "" }, named)).toEqual(
      {},
    );
  });

  it("keeps sandbox sizes set through the API when the console saves an edit elsewhere", () => {
    const stored: ProfileDefinition = { instructions: "x", sandboxSize: "l", sandboxSizes: ["xl"] };
    expect(
      definitionFromForm({ ...formFromDefinition(stored), instructions: "y" }, stored),
    ).toEqual({
      instructions: "y",
      sandboxSize: "l",
      sandboxSizes: ["xl"],
    });
    // Cleared: the size inherits again, and an explicit empty list keeps its spelling.
    const cleared = definitionFromForm(
      { ...formFromDefinition(stored), sandboxSize: "", sandboxSizes: [] },
      stored,
    );
    expect(cleared).toEqual({ instructions: "x", sandboxSizes: [] });
  });

  it("omits a cleared override instead of sending it empty", () => {
    const form = formFromDefinition({
      defaultModel: "a/b",
      reasoning: "low",
      turnBudget: 5,
      tokenBudget: 9,
      instructions: "x",
    });
    const cleared = definitionFromForm(
      {
        ...form,
        defaultModel: "",
        reasoning: "",
        turnBudget: " ",
        tokenBudget: "",
        instructions: "  ",
      },
      { defaultModel: "a/b", reasoning: "low", turnBudget: 5, tokenBudget: 9, instructions: "x" },
    );
    expect(cleared).toEqual({});
    expect("reasoning" in cleared).toBe(false);
  });

  it("tells all tools (omitted) from none (empty) from a subset", () => {
    const base = formFromDefinition({});
    expect(definitionFromForm(base)).toEqual({});
    expect(definitionFromForm({ ...base, allTools: false })).toEqual({ tools: [] });
    expect(definitionFromForm({ ...base, allTools: false, tools: ["read"] })).toEqual({
      tools: ["read"],
    });
    expect(definitionFromForm({ ...base, allModelTools: false })).toEqual({ modelTools: [] });
  });

  it("drops false toggles and empty server lists that the original did not spell", () => {
    const form = formFromDefinition({});
    expect(definitionFromForm({ ...form, repoSkills: false, mcpServers: [] }, {})).toEqual({});
    expect(definitionFromForm({ ...form, repoSkills: true }, {})).toEqual({ repoSkills: true });
  });
});

describe("definitionProblems (mirrors validateProfileDefinition)", () => {
  it("accepts the empty definition", () => {
    expect(definitionProblems({})).toEqual([]);
  });

  it("refuses modelTools that are not in tools", () => {
    expect(definitionProblems({ tools: ["read"], modelTools: ["bash"] })).toEqual([
      'modelTools "bash" is not in tools',
    ]);
  });

  it("checks the model, reasoning, budget, instructions and names", () => {
    expect(definitionProblems({ defaultModel: "nomodel" })).toHaveLength(1);
    expect(definitionProblems({ defaultModel: "a/b c" })).toHaveLength(1);
    expect(definitionProblems({ turnBudget: 0 })).toHaveLength(1);
    expect(definitionProblems({ turnBudget: 1.5 })).toHaveLength(1);
    expect(definitionProblems({ turnBudget: 1_000_001 })).toHaveLength(1);
    expect(definitionProblems({ turnBudget: Number.NaN })).toHaveLength(1);
    expect(definitionProblems({ tokenBudget: 0 })).toHaveLength(1);
    expect(definitionProblems({ tokenBudget: 2.5 })).toHaveLength(1);
    expect(definitionProblems({ tokenBudget: 1_000_000_000_001 })).toHaveLength(1);
    expect(definitionProblems({ tokenBudget: 1_000_000_000_000 })).toEqual([]);
    expect(definitionProblems({ instructions: "   " })).toHaveLength(1);
    expect(definitionProblems({ instructions: "x".repeat(8001) })).toHaveLength(1);
    expect(definitionProblems({ mcpServers: ["Bad Name"] })).toHaveLength(1);
    expect(definitionProblems({ sandboxSize: "Big" })).toHaveLength(1);
    expect(definitionProblems({ sandboxSizes: ["x".repeat(17)] })).toHaveLength(1);
    expect(definitionProblems({ sandboxSize: "m", sandboxSizes: ["l"] })).toEqual([]);
    expect(
      definitionProblems({ turnBudget: 1_000_000, instructions: "ok", defaultModel: "a/b/c" }),
    ).toEqual([]);
  });

  it("explains that skills and repoSkills need read in explicit lists, without adding it", () => {
    const pin = { name: "lint", version: 1 };
    expect(readProblems({ skills: [pin], tools: ["bash"] })).toEqual([
      "skills need the read tool, but tools does not include it",
    ]);
    expect(readProblems({ repoSkills: true, tools: ["read"], modelTools: ["read"] })).toEqual([]);
    expect(readProblems({ repoSkills: true, modelTools: ["bash"] })).toEqual([
      "repoSkills needs the read tool, but modelTools does not include it",
    ]);
    expect(readProblems({ skills: [pin] })).toEqual([]);
    expect(readProblems({ repoSkills: false, tools: [] })).toEqual([]);
    expect(definitionProblems({ skills: [pin], tools: [] })).toHaveLength(1);
  });
});

describe("references to removed things", () => {
  const known = {
    tools: ["read", "bash"],
    mcpServers: [
      { name: "docs", enabled: true },
      { name: "off", enabled: false },
    ],
  };

  it("finds removed tools and deleted servers, and a disabled server is only noted", () => {
    expect(
      referenceProblems(
        { tools: ["read", "gone"], modelTools: ["gone2"], mcpServers: ["docs", "deleted", "off"] },
        known,
      ),
    ).toEqual({
      unknownTools: [
        { field: "tools", name: "gone" },
        { field: "modelTools", name: "gone2" },
      ],
      missingServers: ["deleted"],
      disabledServers: ["off"],
      missingRuleSets: [],
    });
  });

  it("finds deleted egress rule sets only once the sets are known", () => {
    const definition: ProfileDefinition = { egressRuleSets: ["npm", "gone"] };
    expect(referenceProblems(definition, known).missingRuleSets).toEqual([]);
    const problems = referenceProblems(definition, { ...known, egressRuleSets: ["npm"] });
    expect(problems.missingRuleSets).toEqual(["gone"]);
    const form = formFromDefinition(definition);
    expect(withoutBrokenReferences(form, problems).egressRuleSets).toEqual(["npm"]);
  });

  it("round-trips egressRuleSets, keeping an explicit empty list the profile had", () => {
    const stored: ProfileDefinition = { egressRuleSets: ["npm", "pypi"] };
    expect(definitionFromForm(formFromDefinition(stored), stored)).toEqual(stored);
    expect(definitionFromForm(formFromDefinition({}))).toEqual({});
    const cleared = definitionFromForm(
      { ...formFromDefinition(stored), egressRuleSets: [] },
      stored,
    );
    expect(cleared).toEqual({ egressRuleSets: [] });
    expect(definitionFromForm({ ...formFromDefinition(stored), egressRuleSets: [] })).toEqual({});
    expect(isEmptyForm(formFromDefinition(stored))).toBe(false);
  });

  it("checks the names of egressRuleSets like the API", () => {
    expect(definitionProblems({ egressRuleSets: ["npm", "open-web"] })).toEqual([]);
    expect(definitionProblems({ egressRuleSets: ["Bad Name"] })).toEqual([
      "egressRuleSets must be an array of rule set names",
    ]);
  });

  it("removes what the API would refuse and keeps the rest", () => {
    const definition: ProfileDefinition = {
      tools: ["read", "gone"],
      modelTools: ["read"],
      mcpServers: ["docs", "deleted"],
    };
    const fixed = withoutBrokenReferences(
      formFromDefinition(definition),
      referenceProblems(definition, known),
    );
    expect(definitionFromForm(fixed, definition)).toEqual({
      tools: ["read"],
      modelTools: ["read"],
      mcpServers: ["docs"],
    });
  });
});

describe("executableSkillsWithoutBash", () => {
  const skills: SkillInfo[] = [
    {
      name: "lint",
      currentVersion: 2,
      versions: [
        {
          version: 2,
          digest: "d",
          description: "",
          disableModelInvocation: false,
          files: [{ path: "run.sh", size: 1, executable: true }],
        },
        {
          version: 1,
          digest: "c",
          description: "",
          disableModelInvocation: false,
          files: [{ path: "SKILL.md", size: 1, executable: false }],
        },
      ],
    },
  ];

  it("warns when a pinned version has executable files and an explicit list lacks bash", () => {
    const pin = [{ name: "lint", version: 2 }];
    expect(executableSkillsWithoutBash({ skills: pin, tools: ["read"] }, skills)).toEqual(["lint"]);
    expect(executableSkillsWithoutBash({ skills: pin, modelTools: ["read"] }, skills)).toEqual([
      "lint",
    ]);
  });

  it("is quiet with bash, with all tools, or without executable files", () => {
    const pin = [{ name: "lint", version: 2 }];
    expect(executableSkillsWithoutBash({ skills: pin, tools: ["read", "bash"] }, skills)).toEqual(
      [],
    );
    expect(executableSkillsWithoutBash({ skills: pin }, skills)).toEqual([]);
    expect(
      executableSkillsWithoutBash(
        { skills: [{ name: "lint", version: 1 }], tools: ["read"] },
        skills,
      ),
    ).toEqual([]);
  });
});

describe("diffs", () => {
  it("tells an omitted field from an empty one and shows explicit off", () => {
    expect(diffDefinitions({}, { tools: [], reasoning: "off" })).toEqual([
      { field: "tools", before: "all tools", after: "no tools" },
      { field: "reasoning", before: "global default", after: "off" },
    ]);
    expect(diffDefinitions({ tools: [] }, {})).toEqual([
      { field: "tools", before: "no tools", after: "all tools" },
    ]);
  });

  it("shows sandbox sizes, and a reordered list is no change", () => {
    expect(diffDefinitions({}, { sandboxSize: "l", sandboxSizes: ["xl", "m"] })).toEqual([
      { field: "sandboxSize", before: "global default", after: "l" },
      { field: "sandboxSizes", before: "only the default", after: "m, xl" },
    ]);
    expect(diffDefinitions({}, { egressRuleSets: ["pypi", "npm"] })).toEqual([
      { field: "egressRuleSets", before: "only the sets that apply to all", after: "npm, pypi" },
    ]);
    expect(
      diffDefinitions({ egressRuleSets: ["npm", "pypi"] }, { egressRuleSets: ["pypi", "npm"] }),
    ).toEqual([]);
    expect(diffDefinitions({ sandboxSizes: ["m", "xl"] }, { sandboxSizes: ["xl", "m"] })).toEqual(
      [],
    );
  });

  it("ignores a digest the API has not filled in yet", () => {
    expect(
      diffDefinitions(
        { skills: [{ name: "a", version: 1, digest: "x" }] },
        { skills: [{ name: "a", version: 1 }] },
      ),
    ).toEqual([]);
    expect(
      diffDefinitions(
        { skills: [{ name: "a", version: 1 }] },
        { skills: [{ name: "a", version: 2 }] },
      ),
    ).toEqual([{ field: "skills", before: "a@v1", after: "a@v2" }]);
  });

  it("diffs settings, with a null old for the seed", () => {
    const values = valuesFromForm(
      formFromValues({
        defaultModel: "a/b",
        allowlist: ["a/b"],
        reasoning: null,
        maxReasoning: "low",
        defaultProfile: "coding",
        turnBudget: 10,
        tokenBudget: null,
        repoAllowlist: [],
      }),
    );
    expect(diffSettings(values, { ...values, reasoning: "low", turnBudget: 20 })).toEqual([
      { field: "reasoning", before: "model default", after: "low" },
      { field: "turnBudget", before: "10", after: "20" },
    ]);
    expect(diffSettings(values, { ...values, tokenBudget: 5000 })).toEqual([
      { field: "tokenBudget", before: "no limit", after: "5000" },
    ]);
    expect(diffSettings(values, { ...values, repoAllowlist: ["acme/*"] })).toEqual([
      { field: "repoAllowlist", before: "none (repo sessions refused)", after: "acme/*" },
    ]);
    expect(diffSettings(null, values)).toHaveLength(8);
    // A reordering of the allowlist is no change; a spelling of an empty list is no change either.
    expect(
      diffSettings(
        { ...values, allowlist: ["a/b", "c/d"] },
        { ...values, allowlist: ["c/d", "a/b"] },
      ),
    ).toEqual([]);
    expect(diffDefinitions({}, { mcpServers: [], repoSkills: false })).toEqual([]);
  });
});

describe("settings form", () => {
  it("sends null for a cleared reasoning and max reasoning", () => {
    const form = formFromValues({
      defaultModel: "a/b",
      allowlist: ["a/b", "c/d"],
      reasoning: "low",
      maxReasoning: "high",
      defaultProfile: "coding",
      turnBudget: 7,
      tokenBudget: null,
      repoAllowlist: [],
    });
    expect(valuesFromForm({ ...form, reasoning: "", maxReasoning: "" })).toMatchObject({
      reasoning: null,
      maxReasoning: null,
    });
    expect(valuesFromForm(form)).toMatchObject({
      reasoning: "low",
      maxReasoning: "high",
      allowlist: ["a/b", "c/d"],
    });
  });

  it("puts the default model first in the allowlist, once", () => {
    const form = formFromValues({
      defaultModel: "a/b",
      allowlist: [],
      reasoning: null,
      maxReasoning: null,
      defaultProfile: "coding",
      turnBudget: 1,
      tokenBudget: null,
      repoAllowlist: [],
    });
    expect(valuesFromForm({ ...form, allowlist: ["c/d", "a/b"] }).allowlist).toEqual([
      "a/b",
      "c/d",
    ]);
  });

  it("mirrors validateSettings", () => {
    const ok = {
      defaultModel: "a/b",
      allowlist: ["c/d"],
      reasoning: null,
      maxReasoning: null,
      defaultProfile: "coding",
      turnBudget: 5,
      tokenBudget: null,
      repoAllowlist: [],
    } satisfies SettingsValues;
    expect(settingsProblems(ok)).toEqual([]);
    expect(settingsProblems({ ...ok, defaultModel: "nope" })).toHaveLength(1);
    expect(settingsProblems({ ...ok, allowlist: ["x"] })).toHaveLength(1);
    expect(settingsProblems({ ...ok, reasoning: "high", maxReasoning: "low" })).toHaveLength(1);
    expect(settingsProblems({ ...ok, turnBudget: 0 })).toHaveLength(1);
    expect(settingsProblems({ ...ok, turnBudget: Number.NaN })).toHaveLength(1);
    expect(settingsProblems({ ...ok, tokenBudget: 1 })).toEqual([]);
    expect(settingsProblems({ ...ok, tokenBudget: 0 })).toHaveLength(1);
    expect(settingsProblems({ ...ok, tokenBudget: 1.5 })).toHaveLength(1);
    expect(settingsProblems({ ...ok, defaultProfile: "" })).toHaveLength(1);
  });
});

describe("profileNameProblem", () => {
  it("accepts a valid name and refuses a malformed one and the reserved create route", () => {
    expect(profileNameProblem("research")).toBeUndefined();
    expect(profileNameProblem("newer")).toBeUndefined();
    expect(profileNameProblem("Bad Name")).toMatch(/lowercase letters/);
    expect(profileNameProblem("new")).toBe('The name "new" is reserved.');
  });
});
