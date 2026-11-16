import { describe, expect, it } from "vitest";
import { chooseModel, loadModelPolicy, parseAllowlist } from "../src/models.ts";

describe("allowlist", () => {
  it("splits the first slash only, so model ids may contain slashes", () => {
    expect(parseAllowlist("openrouter/openai/gpt-4.1-nano, scripted/scripted-1\n")).toEqual([
      { provider: "openrouter", model: "openai/gpt-4.1-nano" },
      { provider: "scripted", model: "scripted-1" },
    ]);
  });

  it("rejects entries that are not provider/model, naming the entry", () => {
    expect(() => parseAllowlist("justaname")).toThrow(/"justaname"/);
    expect(() => parseAllowlist("/model")).toThrow(/not provider\/model/);
    expect(() => parseAllowlist("provider/")).toThrow(/not provider\/model/);
    expect(() => parseAllowlist("a/b c")).toThrow(/not provider\/model/);
  });

  it("defaults to the scripted model, and always allows the default", () => {
    const policy = loadModelPolicy({});
    expect(policy.default).toEqual({ provider: "scripted", model: "scripted-1" });
    expect(policy.allowed.map((m) => m.model)).toEqual(["scripted-1", "scripted-2"]);
    const custom = loadModelPolicy({
      PI_MODEL_PROVIDER: "openrouter",
      PI_MODEL_ID: "openai/gpt-4.1-nano",
      PI_MODEL_ALLOWLIST: "openrouter/google/gemini-2.5-flash-lite",
    });
    expect(custom.allowed).toHaveLength(2);
    expect(custom.allowed[0]).toEqual(custom.default);
  });
});

describe("chooseModel", () => {
  const policy = loadModelPolicy({
    PI_MODEL_ALLOWLIST: "scripted/scripted-1,scripted/scripted-2,openrouter/openai/gpt-4.1-nano",
  });

  it("uses the default when the body names no model", () => {
    expect(chooseModel(policy, {})).toEqual(policy.default);
  });

  it("accepts an allowed pair", () => {
    expect(chooseModel(policy, { provider: "openrouter", model: "openai/gpt-4.1-nano" })).toEqual({
      provider: "openrouter",
      model: "openai/gpt-4.1-nano",
    });
  });

  it("refuses a pair that is not on the list, however close it looks", () => {
    expect(chooseModel(policy, { provider: "openrouter", model: "openai/gpt-5" })).toMatch(
      /not allowed/,
    );
    expect(chooseModel(policy, { provider: "openai", model: "gpt-4.1-nano" })).toMatch(
      /not allowed/,
    );
    // The model must match as a whole, not as a prefix.
    expect(chooseModel(policy, { provider: "scripted", model: "scripted-1/x" })).toMatch(
      /not allowed/,
    );
  });

  it("refuses half a model and non-strings", () => {
    expect(chooseModel(policy, { provider: "scripted" })).toMatch(/both/);
    expect(chooseModel(policy, { model: "scripted-1" })).toMatch(/both/);
    expect(chooseModel(policy, { provider: 1, model: "x" })).toMatch(/both/);
    expect(chooseModel(policy, { provider: "", model: "" })).toMatch(/both/);
  });
});

describe("reasoning effort", () => {
  it("comes from PI_MODEL_REASONING and goes to every chosen model", () => {
    const policy = loadModelPolicy({
      PI_MODEL_REASONING: "medium",
      PI_MODEL_ALLOWLIST: "openai-codex/gpt-6.1-terra",
    });
    expect(policy.default).toEqual({
      provider: "scripted",
      model: "scripted-1",
      reasoning: "medium",
    });
    expect(chooseModel(policy, { provider: "openai-codex", model: "gpt-6.1-terra" })).toEqual({
      provider: "openai-codex",
      model: "gpt-6.1-terra",
      reasoning: "medium",
    });
  });

  it("does not let a slash-joined provider/model pair match a different allowed pair", () => {
    const policy = loadModelPolicy({ PI_MODEL_ALLOWLIST: "openrouter/openai/gpt-4.1-nano" });
    expect(chooseModel(policy, { provider: "openrouter", model: "openai/gpt-4.1-nano" })).toEqual(
      expect.objectContaining({ provider: "openrouter", model: "openai/gpt-4.1-nano" }),
    );
    expect(chooseModel(policy, { provider: "openrouter/openai", model: "gpt-4.1-nano" })).toMatch(
      /not allowed/,
    );
  });

  it("rejects an unknown level at start", () => {
    expect(() => loadModelPolicy({ PI_MODEL_REASONING: "max" })).toThrow(/PI_MODEL_REASONING/);
  });
});
