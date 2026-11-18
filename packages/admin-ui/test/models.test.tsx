import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Combobox } from "@/components/combobox";
import { withModel, withoutModel } from "@/components/model-picker";
import { filterOptions, MATCH_LIMIT, shownAllowlist } from "@/lib/models";
import type { PickOption } from "@/lib/models";

const many: PickOption[] = Array.from({ length: 300 }, (_, index) => ({
  key: `big/m-${String(index)}`,
  label: `Model ${String(index)}`,
  search: `m-${String(index)}`,
}));

describe("filterOptions", () => {
  it("caps the matches and counts the rest", () => {
    const all = filterOptions(many, "");
    expect(all.shown).toHaveLength(MATCH_LIMIT);
    expect(all.more).toBe(300 - MATCH_LIMIT);
  });

  it("matches every word against the name or the id, in any case", () => {
    expect(filterOptions(many, "MODEL 29").more).toBe(0);
    expect(filterOptions(many, "m-29 model").shown.map((o) => o.label)).toContain("Model 29");
    expect(filterOptions(many, "nothing").shown).toEqual([]);
  });
});

describe("allowlist edits", () => {
  it("adds once, never the default, and removes", () => {
    expect(withModel(["a/1"], "a/2", "a/0")).toEqual(["a/1", "a/2"]);
    expect(withModel(["a/1"], "a/1", "a/0")).toEqual(["a/1"]);
    expect(withModel(["a/1"], "a/0", "a/0")).toEqual(["a/1"]);
    expect(withoutModel(["a/1", "a/2"], "a/1")).toEqual(["a/2"]);
  });
});

describe("shownAllowlist", () => {
  it("lists scripted models only while no real model is allowed, and always keeps the current one", () => {
    const scripted = ["scripted/scripted-1", "scripted/scripted-2"];
    expect(shownAllowlist(scripted)).toEqual(scripted);
    expect(shownAllowlist(["openai/gpt-fast", ...scripted])).toEqual(["openai/gpt-fast"]);
    expect(shownAllowlist(["openai/gpt-fast", ...scripted], "scripted/scripted-2")).toEqual([
      "openai/gpt-fast",
      "scripted/scripted-2",
    ]);
  });
});

describe("Combobox", () => {
  it("lists at most a screenful, filters while typing and picks with the keyboard", async () => {
    const onPick = vi.fn<(key: string) => void>();
    render(<Combobox id="c" ariaLabel="Model" options={many} display="" onPick={onPick} />);
    const input = screen.getByRole("combobox", { name: "Model" });
    await userEvent.click(input);
    expect(screen.getAllByRole("option")).toHaveLength(MATCH_LIMIT);
    expect(screen.getByText(/280 more/)).toBeInTheDocument();
    await userEvent.type(input, "model 7{ArrowDown}{Enter}");
    expect(onPick).toHaveBeenCalledWith("big/m-17");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("closes on Escape without picking, and says when nothing matches", async () => {
    const onPick = vi.fn<(key: string) => void>();
    render(<Combobox id="c" ariaLabel="Model" options={many} display="Model 1" onPick={onPick} />);
    const input = screen.getByRole("combobox");
    expect(input).toHaveValue("Model 1");
    await userEvent.type(input, "zzz");
    expect(screen.getByText("No match")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(onPick).not.toHaveBeenCalled();
    expect(input).toHaveAttribute("aria-expanded", "false");
  });
});
