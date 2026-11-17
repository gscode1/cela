import { describe, expect, it } from "vitest";
import { applyIntent, intentFromSearch, searchOf } from "@/lib/profile-links";
import { formFromDefinition } from "@/lib/profile-form";

describe("profile link contract", () => {
  it("reads pinSkill and addMcp", () => {
    expect(intentFromSearch(new URLSearchParams("pinSkill=my-skill@3&addMcp=docs"))).toEqual({
      pinSkill: { name: "my-skill", version: 3 },
      addMcp: "docs",
    });
  });

  it("ignores a malformed pin", () => {
    for (const bad of ["x", "x@0", "x@v1", "@1", "x@1.5"])
      expect(intentFromSearch(new URLSearchParams({ pinSkill: bad }))).toEqual({});
  });

  it("round-trips through the query string", () => {
    const intent = { pinSkill: { name: "a", version: 2 }, addMcp: "b" };
    expect(intentFromSearch(new URLSearchParams(searchOf(intent)))).toEqual(intent);
  });

  it("adds a pin and a server to a draft, replacing a pin of the same skill", () => {
    const form = formFromDefinition({
      skills: [{ name: "a", version: 1 }],
      mcpServers: ["b"],
    });
    const next = applyIntent(form, { pinSkill: { name: "a", version: 2 }, addMcp: "c" });
    expect(next.skills).toEqual([{ name: "a", version: 2 }]);
    expect(next.mcpServers).toEqual(["b", "c"]);
    expect(applyIntent(next, { addMcp: "c" }).mcpServers).toEqual(["b", "c"]);
  });
});
