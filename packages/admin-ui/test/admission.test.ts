import { describe, expect, it } from "vitest";
import {
  admit,
  admitDefault,
  effectiveAllowlist,
  failingProfiles,
  reviewProfileSave,
  reviewSettingsSave,
} from "@/lib/admission";
import type { ProfileFacts } from "@/lib/admission";
import type { SettingsValues } from "@/lib/api/settings";

const settings: SettingsValues = {
  defaultModel: "scripted/scripted-1",
  allowlist: ["scripted/scripted-1", "scripted/scripted-2"],
  reasoning: null,
  maxReasoning: null,
  defaultProfile: "coding",
  turnBudget: 100,
};

const coding: ProfileFacts = {
  name: "coding",
  enabledForNew: true,
  definition: {},
  currentVersion: 1,
};

function profile(
  name: string,
  definition: ProfileFacts["definition"],
  enabledForNew = true,
): ProfileFacts {
  return { name, enabledForNew, definition, currentVersion: 2 };
}

describe("effectiveAllowlist", () => {
  it("always has the default model, first, once", () => {
    expect(
      effectiveAllowlist({ ...settings, defaultModel: "a/b", allowlist: ["c/d", "a/b"] }),
    ).toEqual(["a/b", "c/d"]);
    expect(effectiveAllowlist({ ...settings, defaultModel: "a/b", allowlist: [] })).toEqual([
      "a/b",
    ]);
  });
});

describe("admit (what POST /sessions does with no caller overrides)", () => {
  it("takes model, reasoning and budget from the settings for an empty profile", () => {
    expect(admit({ ...settings, reasoning: "low" }, { ...coding, version: 1 })).toEqual({
      ok: true,
      model: "scripted/scripted-1",
      modelFrom: "settings",
      reasoning: "low",
      reasoningFrom: "settings",
      turnBudget: 100,
      turnBudgetFrom: "settings",
    });
  });

  it("lets the profile win over the settings, with explicit off", () => {
    const result = admit(
      { ...settings, reasoning: "high" },
      {
        ...profile("fast", {
          defaultModel: "scripted/scripted-2",
          reasoning: "off",
          turnBudget: 5,
        }),
        version: 2,
      },
    );
    expect(result).toMatchObject({
      ok: true,
      model: "scripted/scripted-2",
      modelFrom: "profile",
      reasoning: "off",
      reasoningFrom: "profile",
      turnBudget: 5,
      turnBudgetFrom: "profile",
    });
  });

  it("reports no reasoning when neither says one", () => {
    expect(admit(settings, { ...coding, version: 1 })).toMatchObject({
      reasoning: null,
      reasoningFrom: "none",
    });
  });

  it("refuses a model that is not on the allowlist, with ingest's message", () => {
    const result = admit(settings, {
      ...profile("odd", { defaultModel: "other/model" }),
      version: 3,
    });
    expect(result).toMatchObject({
      ok: false,
      kind: "model",
      message: 'profile "odd" v3: model other/model is not allowed',
    });
  });

  it("allows the default model even when the allowlist does not list it", () => {
    const result = admit(
      { ...settings, defaultModel: "x/y", allowlist: [] },
      { ...profile("p", { defaultModel: "x/y" }), version: 2 },
    );
    expect(result.ok).toBe(true);
  });

  it("compares the pair: a model id with a slash is not another provider", () => {
    const result = admit(
      { ...settings, allowlist: ["openrouter/openai/gpt"] },
      { ...profile("p", { defaultModel: "openrouter/openai/gpt" }), version: 2 },
    );
    expect(result.ok).toBe(true);
  });

  it("refuses a profile reasoning above the cap, and checks it before the model", () => {
    const result = admit(
      { ...settings, maxReasoning: "low" },
      { ...profile("deep", { reasoning: "high", defaultModel: "other/model" }), version: 4 },
    );
    expect(result).toMatchObject({
      ok: false,
      kind: "reasoning",
      message: 'profile "deep" v4: reasoning high is above the allowed maximum low',
    });
  });

  it("does not check the settings' own reasoning against the cap", () => {
    // validateSettings already forbids it; a profile without reasoning inherits it unchecked.
    expect(
      admit({ ...settings, reasoning: "high", maxReasoning: "low" }, { ...coding, version: 1 }).ok,
    ).toBe(true);
  });

  it("accepts a reasoning at the cap", () => {
    expect(
      admit(
        { ...settings, maxReasoning: "low" },
        { ...profile("p", { reasoning: "low" }), version: 2 },
      ).ok,
    ).toBe(true);
  });

  it("refuses a disabled profile with a fix", () => {
    const result = admit(settings, { ...profile("old", {}, false), version: 2 });
    expect(result).toMatchObject({
      ok: false,
      kind: "disabled",
      message: 'profile "old" is not available for new sessions',
    });
  });
});

describe("admitDefault", () => {
  it("is refused for a missing, invalid or disabled default, never replaced", () => {
    expect(admitDefault({ ...settings, defaultProfile: "gone" }, [coding], [])).toMatchObject({
      ok: false,
      kind: "missing",
      message: 'the default profile "gone" does not exist',
    });
    expect(
      admitDefault(
        { ...settings, defaultProfile: "bad" },
        [coding],
        [{ name: "bad", message: "x" }],
      ),
    ).toMatchObject({ ok: false, kind: "invalid" });
    expect(admitDefault(settings, [{ ...coding, enabledForNew: false }], [])).toMatchObject({
      ok: false,
      kind: "disabled",
      message: 'the default profile "coding" is not available for new sessions',
    });
  });

  it("passes the default profile through the same checks", () => {
    expect(
      admitDefault(
        { ...settings, maxReasoning: "off" },
        [profile("coding", { reasoning: "low" })],
        [],
      ),
    ).toMatchObject({ ok: false, kind: "reasoning" });
    expect(admitDefault(settings, [coding], [])).toMatchObject({ ok: true });
  });
});

describe("failingProfiles and reviewSettingsSave", () => {
  const fast = profile("fast", { defaultModel: "scripted/scripted-2" });
  const disabled = profile("disabled", { defaultModel: "nowhere/none" }, false);

  it("lists enabled profiles that would fail, skipping disabled ones and the excepted one", () => {
    const bad = profile("bad", { defaultModel: "nowhere/none" });
    expect(failingProfiles(settings, [coding, fast, disabled, bad]).map((f) => f.name)).toEqual([
      "bad",
    ]);
    expect(failingProfiles(settings, [bad], "bad")).toEqual([]);
  });

  it("blocks when the selected default would fail, and only warns for the others", () => {
    const next = { ...settings, allowlist: ["scripted/scripted-1"] };
    const review = reviewSettingsSave(next, [coding, fast], []);
    expect(review.blocking).toBeUndefined();
    expect(review.warnings.map((w) => w.name)).toEqual(["fast"]);

    const blocked = reviewSettingsSave({ ...next, defaultProfile: "fast" }, [coding, fast], []);
    expect(blocked.blocking).toMatchObject({ kind: "model" });
    expect(blocked.warnings).toEqual([]);
  });

  it("blocks a default that is missing", () => {
    expect(
      reviewSettingsSave({ ...settings, defaultProfile: "gone" }, [coding], []).blocking,
    ).toMatchObject({
      kind: "missing",
    });
  });
});

describe("reviewProfileSave", () => {
  it("blocks when the profile is the default and would fail", () => {
    const review = reviewProfileSave(settings, profile("coding", { defaultModel: "nowhere/none" }));
    expect(review.blocking?.fix).toContain("default profile");
    expect(review.warnings).toEqual([]);
  });

  it("only warns for another enabled profile", () => {
    const review = reviewProfileSave(settings, profile("other", { defaultModel: "nowhere/none" }));
    expect(review.blocking).toBeUndefined();
    expect(review.warnings.map((w) => w.name)).toEqual(["other"]);
  });

  it("has nothing to say for a profile that would be admitted", () => {
    const review = reviewProfileSave(settings, profile("other", { reasoning: "off" }));
    expect(review.blocking).toBeUndefined();
    expect(review.warnings).toEqual([]);
    expect(review.admission.ok).toBe(true);
  });
});
