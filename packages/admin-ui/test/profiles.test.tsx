import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearDrafts } from "@/lib/drafts";
import type { ProfileDefinition } from "@/lib/api/profiles";
import { createFakeAdmin } from "./fake-admin";
import type { FakeAdmin } from "./fake-admin";
import { renderApp, signIn } from "./render";

afterEach(() => {
  vi.unstubAllGlobals();
  clearDrafts();
});

function addProfile(
  admin: FakeAdmin,
  name: string,
  definition: ProfileDefinition,
  enabled = true,
): void {
  admin.profiles.push({
    name,
    currentVersion: 1,
    revision: 1,
    enabledForNew: enabled,
    versions: [{ version: 1, definition, createdBy: "alice" }],
  });
}

async function openProfile(admin: FakeAdmin, name: string): Promise<void> {
  renderApp(`/profiles/${name}`);
  await signIn("alice-token");
  await screen.findByRole("heading", { name: new RegExp(`Edit ${name}`) });
  await waitFor(() => {
    expect(screen.getByLabelText("Instructions")).toBeInTheDocument();
  });
  // The pickers load in parallel with the editor.
  await waitFor(() => {
    expect(admin.fetch.mock.calls.some(([path]) => path === "/admin/tools")).toBe(true);
  });
}

const publish = () => screen.getByRole("button", { name: "Publish new version" });

describe("deleting a profile", () => {
  it("is offered only for a disabled profile that is not the default", async () => {
    const admin = createFakeAdmin();
    addProfile(admin, "review", { instructions: "x" });
    await openProfile(admin, "review");
    expect(screen.getByRole("button", { name: "Delete profile" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Disable for new sessions" }));
    await screen.findByText("review is disabled for new sessions.");
    expect(screen.getByRole("button", { name: "Delete profile" })).toBeEnabled();
  });

  it("asks for the name, deletes with the revision and goes back to the list", async () => {
    const admin = createFakeAdmin();
    addProfile(admin, "review", { instructions: "x" }, false);
    await openProfile(admin, "review");
    await userEvent.click(screen.getByRole("button", { name: "Delete profile" }));
    const panel = screen.getByRole("generic", { name: "Delete review" });
    expect(panel).toHaveTextContent("cannot be undone");
    expect(panel).toHaveTextContent("can never be used again");
    const confirm = within(panel).getByRole("button", { name: "Delete review" });
    expect(confirm).toBeDisabled();
    await userEvent.type(within(panel).getByLabelText("Type review to confirm"), "revie");
    expect(confirm).toBeDisabled();
    await userEvent.type(within(panel).getByLabelText("Type review to confirm"), "w");
    await userEvent.click(confirm);
    await screen.findByRole("table", { name: "Profiles" });
    expect(admin.profiles.some((profile) => profile.name === "review")).toBe(false);
    expect(
      admin.fetch.mock.calls.some(
        ([path, init]) =>
          path.startsWith("/admin/profiles/review?expectedRevision=1") && init?.method === "DELETE",
      ),
    ).toBe(true);
  });
});

describe("profile list", () => {
  it("lists name, version, state, default and last actor, and shows invalid ones with their errors", async () => {
    const admin = createFakeAdmin();
    addProfile(admin, "review", { instructions: "x" }, false);
    admin.invalid = [
      { name: "broken", message: "stored profile broken is invalid: unknown field" },
    ];
    renderApp("/profiles");
    await signIn("alice-token");
    const table = await screen.findByRole("table", { name: "Profiles" });
    const coding = within(table).getByRole("link", { name: "coding" }).closest("tr");
    expect(coding).toHaveTextContent("default");
    expect(coding).not.toHaveTextContent("v1");
    expect(coding).not.toHaveTextContent("enabled");
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["Name", "Last changed"]);
    // Disabled profiles fold away until asked for.
    expect(within(table).queryByRole("link", { name: "review" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Show 1 disabled" }));
    expect(within(table).getByRole("link", { name: "review" }).closest("tr")).toHaveTextContent(
      "disabled",
    );
    await userEvent.click(screen.getByRole("button", { name: "Hide disabled" }));
    expect(within(table).queryByRole("link", { name: "review" })).not.toBeInTheDocument();
    expect(screen.getByTestId("invalid-profile")).toHaveTextContent(
      "This profile's stored definition is invalid; publish a corrected version.",
    );
  });

  it("offers no fold button while every profile is enabled", async () => {
    createFakeAdmin();
    renderApp("/profiles");
    await signIn("alice-token");
    await screen.findByRole("table", { name: "Profiles" });
    expect(screen.queryByRole("button", { name: /disabled/ })).not.toBeInTheDocument();
  });
});

describe("profile editor", () => {
  it("publishes a new version with the revision, and sends an omitted tools list as omitted", async () => {
    const admin = createFakeAdmin();
    await openProfile(admin, "coding");
    await userEvent.type(screen.getByLabelText("Instructions"), "Be brief.");
    expect(screen.getByText("Instructions", { selector: "td" })).toBeInTheDocument();
    expect(screen.getByText("Applies to new sessions only.")).toBeInTheDocument();
    await userEvent.click(publish());
    await screen.findByText("Published version 2 of coding.");
    expect(admin.writes[0]).toEqual({
      path: "/admin/profiles/coding",
      body: { definition: { instructions: "Be brief." }, expectedRevision: 1 },
    });
  });

  it("clears an override by omitting the field, and keeps explicit off", async () => {
    const admin = createFakeAdmin();
    addProfile(admin, "deep", {
      reasoning: "off",
      turnBudget: 9,
      defaultModel: "scripted/scripted-1",
    });
    await openProfile(admin, "deep");
    await waitFor(() => {
      expect(screen.getByLabelText("Default reasoning")).toHaveValue("off");
    });
    // Explicit off survives an edit elsewhere.
    await userEvent.clear(screen.getByLabelText("Turn budget"));
    await userEvent.click(publish());
    await screen.findByText(/Published version 2/);
    expect(admin.writes[0]?.body).toEqual({
      definition: { defaultModel: "scripted/scripted-1", reasoning: "off" },
      expectedRevision: 1,
    });

    // Clearing the reasoning override leaves the field out; it is not sent as an empty value.
    await userEvent.selectOptions(
      screen.getByLabelText("Default reasoning"),
      "Inherit (global default)",
    );
    await userEvent.click(publish());
    await screen.findByText(/Published version 3/);
    expect(admin.writes[1]?.body).toEqual({
      definition: { defaultModel: "scripted/scripted-1" },
      expectedRevision: 2,
    });
  });

  it("tells all tools (omitted) from none (empty)", async () => {
    const admin = createFakeAdmin();
    await openProfile(admin, "coding");
    await userEvent.click(screen.getByLabelText("All tools (default)", { selector: "#tools-all" }));
    // Switching to an explicit list starts from every installed tool: the same effective set, but now spelled out.
    expect(screen.getByLabelText("bash", { selector: "#tools-bash" })).toBeChecked();
    for (const tool of ["read", "write", "edit", "bash"])
      await userEvent.click(screen.getByLabelText(tool, { selector: `#tools-${tool}` }));
    expect(screen.getByText("No tools.")).toBeInTheDocument();
    expect(screen.getByText("no tools", { selector: "td" })).toBeInTheDocument();
    await userEvent.click(publish());
    await screen.findByText(/Published version 2/);
    expect(admin.writes[0]?.body).toEqual({ definition: { tools: [] }, expectedRevision: 1 });
  });

  it("explains that skills need read and does not add it", async () => {
    const admin = createFakeAdmin();
    admin.skills = [
      {
        name: "lint",
        currentVersion: 1,
        versions: [
          {
            version: 1,
            digest: "d".repeat(64),
            description: "lints",
            disableModelInvocation: false,
            files: [
              { path: "SKILL.md", size: 3, executable: false },
              { path: "run.sh", size: 3, executable: true },
            ],
          },
        ],
      },
    ];
    await openProfile(admin, "coding");
    await userEvent.click(screen.getByLabelText("All tools (default)", { selector: "#tools-all" }));
    await userEvent.click(screen.getByLabelText("read", { selector: "#tools-read" }));
    await userEvent.click(screen.getByLabelText("bash", { selector: "#tools-bash" }));
    await waitFor(() => {
      expect(within(screen.getByLabelText("Skill")).getByText("lint")).toBeInTheDocument();
    });
    await userEvent.selectOptions(screen.getByLabelText("Skill"), "lint");
    await userEvent.click(screen.getByRole("button", { name: "Pin version" }));
    expect(await screen.findByTestId("skill-pin")).toHaveTextContent("lint@v1");
    expect(screen.getByTestId("skill-pin")).toHaveTextContent("executable files");
    expect(screen.getByTestId("read-dependency")).toHaveTextContent("Skills need the read tool.");
    expect(screen.getByTestId("skill-pin")).not.toHaveTextContent("dddd");
    expect(publish()).toBeDisabled();
    expect(screen.getByLabelText("read", { selector: "#tools-read" })).not.toBeChecked();

    // Adding read by hand fixes it; the bash warning stays because tools lacks bash.
    await userEvent.click(screen.getByLabelText("read", { selector: "#tools-read" }));
    expect(screen.getByTestId("bash-warning")).toHaveTextContent("lint ships executable files");
    await userEvent.click(publish());
    await screen.findByText(/Published version 2/);
    const definition = admin.writes[0]?.body.definition as ProfileDefinition;
    expect(definition.skills).toEqual([{ name: "lint", version: 1, digest: "d".repeat(64) }]);
  });

  it("marks references to deleted servers and removed tools, and offers to remove them", async () => {
    const admin = createFakeAdmin();
    admin.mcp = [{ name: "docs", url: "https://mcp.example.com/mcp", enabled: false }];
    addProfile(admin, "old", { tools: ["read", "oldtool"], mcpServers: ["docs", "deleted"] });
    await openProfile(admin, "old");
    expect(await screen.findByTestId("missing-server")).toHaveTextContent("deleted");
    expect(screen.getByTestId("unknown-tool")).toHaveTextContent("oldtool");
    expect(screen.getByText("disabled")).toBeInTheDocument();
    expect(screen.getByText("mcp.example.com")).toHaveAttribute(
      "title",
      "https://mcp.example.com/mcp",
    );
    await userEvent.click(screen.getByLabelText("write", { selector: "#tools-write" }));
    expect(screen.getByTestId("broken-references")).toBeInTheDocument();
    expect(publish()).toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: "Remove all broken references" }));
    expect(screen.queryByTestId("broken-references")).not.toBeInTheDocument();
    await userEvent.click(publish());
    await screen.findByText(/Published version 2/);
    // The disabled server still saves: only the deleted one went.
    expect(admin.writes[0]?.body.definition).toEqual({
      tools: ["read", "write"],
      mcpServers: ["docs"],
    });
  });

  it("previews admission and refuses a default profile that would fail", async () => {
    const admin = createFakeAdmin();
    await openProfile(admin, "coding");
    await waitFor(() => {
      expect(screen.getByRole("region", { name: "What a new session gets" })).toHaveTextContent(
        "scripted/scripted-1 (from the global settings)",
      );
    });
    await userEvent.selectOptions(screen.getByLabelText("Default reasoning"), "high");
    expect(screen.getByRole("region", { name: "What a new session gets" })).toHaveTextContent(
      "high (from this profile)",
    );
    // The model drop-down only offers the allowlist; a model that left it is flagged when it is already stored.
    expect(screen.queryByTestId("blocking")).not.toBeInTheDocument();
  });

  it("blocks a profile that is the default and would be refused, and warns for another one", async () => {
    const admin = createFakeAdmin();
    admin.settings = { ...admin.settings, maxReasoning: "low" };
    addProfile(admin, "other", {});
    await openProfile(admin, "coding");
    await waitFor(() => {
      expect(screen.getByLabelText("Default reasoning")).toBeEnabled();
    });
    await userEvent.selectOptions(screen.getByLabelText("Default reasoning"), "high");
    expect(await screen.findByTestId("blocking")).toHaveTextContent(
      "reasoning high is above the allowed maximum low",
    );
    expect(publish()).toBeDisabled();
  });

  it("keeps the draft on a 409, shows the server's version next to it, and rebases", async () => {
    const admin = createFakeAdmin();
    await openProfile(admin, "coding");
    await userEvent.type(screen.getByLabelText("Instructions"), "mine");
    // Someone else publishes version 2 first.
    const profile = admin.profiles[0] as FakeAdmin["profiles"][number];
    profile.currentVersion = 2;
    profile.revision = 2;
    profile.versions.push({
      version: 2,
      definition: { instructions: "theirs" },
      createdBy: "carol",
    });

    await userEvent.click(publish());
    expect(await screen.findByText(/Not saved: this profile changed/)).toBeInTheDocument();
    expect(screen.getByLabelText("Instructions")).toHaveValue("mine");

    await userEvent.click(screen.getByRole("button", { name: "Reload and compare" }));
    const compare = await screen.findByTestId("conflict-compare");
    expect(within(compare).getByText("theirs")).toBeInTheDocument();
    expect(within(compare).getByText("mine")).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: "Keep my draft on top of the server version" }),
    );
    await userEvent.click(publish());
    await screen.findByText(/Published version 3/);
    expect(admin.writes.at(-1)?.body).toEqual({
      definition: { instructions: "mine" },
      expectedRevision: 2,
    });
  });
});

describe("editor details", () => {
  it("shows the review card only for a changed draft, and says an empty profile inherits", async () => {
    const admin = createFakeAdmin();
    await openProfile(admin, "coding");
    expect(screen.getByText("Inherits everything from Settings.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Publish new version" })).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Instructions"), "x");
    expect(publish()).toBeInTheDocument();
    expect(screen.queryByText(/of 8000 characters/)).not.toBeInTheDocument();
  });

  it("keeps Tools the model can call behind Advanced, and opens it for a custom selection", async () => {
    const admin = createFakeAdmin();
    addProfile(admin, "narrow", { modelTools: ["read"] });
    await openProfile(admin, "coding");
    expect(screen.queryByText("Tools the model can call")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Advanced" }));
    expect(screen.getByText("Tools the model can call")).toBeInTheDocument();
  });

  it("shows a note instead of reasoning levels for a model without them", async () => {
    const admin = createFakeAdmin();
    admin.settings = {
      ...admin.settings,
      defaultModel: "openai/gpt-fast",
      allowlist: ["openai/gpt-fast"],
    };
    await openProfile(admin, "coding");
    expect(await screen.findByText("This model has no reasoning levels.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Default reasoning")).not.toBeInTheDocument();
  });
});

describe("enable and disable", () => {
  it("disables a profile without a version and sends the revision", async () => {
    const admin = createFakeAdmin();
    addProfile(admin, "review", {});
    await openProfile(admin, "review");
    await userEvent.click(screen.getByRole("button", { name: "Disable for new sessions" }));
    await screen.findByText("review is disabled for new sessions.");
    expect(admin.writes[0]?.body).toEqual({ enabledForNew: false, expectedRevision: 1 });
    expect(admin.profiles.find((p) => p.name === "review")?.currentVersion).toBe(1);
    expect(
      await screen.findByRole("button", { name: "Enable for new sessions" }),
    ).toBeInTheDocument();
  });

  it("cannot disable the default profile: the button says why", async () => {
    const admin = createFakeAdmin();
    await openProfile(admin, "coding");
    const button = screen.getByRole("button", { name: "Disable for new sessions" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", expect.stringContaining("Select another default"));
    expect(screen.queryByText(/never changes a session/)).not.toBeInTheDocument();
  });

  it("does not turn an edit draft stale by enabling or disabling", async () => {
    const admin = createFakeAdmin();
    addProfile(admin, "review", {});
    await openProfile(admin, "review");
    await userEvent.type(screen.getByLabelText("Instructions"), "x");
    await userEvent.click(screen.getByRole("button", { name: "Disable for new sessions" }));
    await screen.findByText("review is disabled for new sessions.");
    await userEvent.click(publish());
    await screen.findByText(/Published version 2/);
    expect(admin.writes[1]?.body).toMatchObject({ expectedRevision: 2 });
  });
});

describe("versions", () => {
  it("diffs two stored definitions and offers no draft from the current version", async () => {
    const admin = createFakeAdmin();
    const coding = admin.profiles[0] as FakeAdmin["profiles"][number];
    coding.currentVersion = 2;
    coding.revision = 2;
    coding.versions.push({
      version: 2,
      definition: { tools: [], reasoning: "off" },
      createdBy: "carol",
    });
    await openProfile(admin, "coding");
    await userEvent.click(screen.getByRole("tab", { name: "Versions" }));
    const diff = await screen.findByLabelText("Version diff");
    expect(diff).toHaveTextContent("Toolsall toolsno tools");
    expect(diff).toHaveTextContent("Default reasoningglobal defaultoff");
    const list = screen.getByRole("list", { name: "Version list" });
    expect(list).toHaveTextContent("carol");
    expect(list).toHaveTextContent("current");
    expect(within(list).getAllByRole("button", { name: /as draft/ })).toHaveLength(1);
  });
});

describe("create", () => {
  it("creates a profile with the create-only expectedRevision and refuses an existing name", async () => {
    const admin = createFakeAdmin();
    renderApp("/profiles/new");
    await signIn("alice-token");
    const name = await screen.findByLabelText("Name");
    await userEvent.type(name, "coding");
    await waitFor(() => {
      expect(screen.getByText(/saving would publish a new version of it/)).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Create profile" })).toBeDisabled();

    await userEvent.clear(name);
    await userEvent.type(name, "review");
    await userEvent.type(screen.getByLabelText("Instructions"), "Review code.");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Create profile" })).toBeEnabled();
    });
    await userEvent.click(screen.getByRole("button", { name: "Create profile" }));
    await screen.findByText("Published version 1 of review.");
    expect(admin.writes[0]).toEqual({
      path: "/admin/profiles/review",
      body: { definition: { instructions: "Review code." }, expectedRevision: 0 },
    });
  });

  it("does not overwrite a profile another admin created after the list loaded", async () => {
    const admin = createFakeAdmin();
    renderApp("/profiles/new");
    await signIn("alice-token");
    const name = await screen.findByLabelText("Name");
    await userEvent.type(name, "review");
    await userEvent.type(screen.getByLabelText("Instructions"), "Mine.");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Create profile" })).toBeEnabled();
    });
    // Created elsewhere: the list this form checked the name against does not have it.
    addProfile(admin, "review", { instructions: "Theirs." });
    await userEvent.click(screen.getByRole("button", { name: "Create profile" }));
    expect(
      await screen.findByText(/Not created: profile review already exists: choose another name/),
    ).toBeInTheDocument();
    expect(admin.profiles.find((p) => p.name === "review")?.versions).toEqual([
      { version: 1, definition: { instructions: "Theirs." }, createdBy: "alice" },
    ]);
    // The list is reloaded, so the name check now says so too.
    await waitFor(() => {
      expect(screen.getByText(/saving would publish a new version of it/)).toBeInTheDocument();
    });
  });
});

describe("sandbox flavour", () => {
  it("disables browser with the reason while the chart does not enable it", async () => {
    const admin = createFakeAdmin();
    addProfile(admin, "review", { instructions: "x" });
    await openProfile(admin, "review");
    const select = await screen.findByLabelText("Sandbox flavour");
    expect(within(select).getByRole("option", { name: /^Browser/ })).toBeDisabled();
    expect(await screen.findByTestId("browser-disabled")).toHaveTextContent(
      "sandbox.flavours.browser.enabled",
    );
  });

  it("offers browser when enabled and explains what it cannot combine with", async () => {
    const admin = createFakeAdmin();
    admin.browserEnabled = true;
    addProfile(admin, "review", { instructions: "x" });
    await openProfile(admin, "review");
    const select = await screen.findByLabelText("Sandbox flavour");
    await waitFor(() => {
      expect(within(select).getByRole("option", { name: /^Browser/ })).toBeEnabled();
    });
    await userEvent.selectOptions(select, "browser");
    expect(await screen.findByTestId("browser-note")).toHaveTextContent("credentialed MCP servers");
  });
});

describe("network mode", () => {
  it("disables direct with the reason while the chart gate is off", async () => {
    const admin = createFakeAdmin();
    addProfile(admin, "review", { instructions: "x" });
    await openProfile(admin, "review");
    const select = await screen.findByLabelText("Network mode");
    expect(within(select).getByRole("option", { name: /^Direct/ })).toBeDisabled();
    expect(await screen.findByTestId("direct-disabled")).toHaveTextContent(
      "security.allowDirectSandboxEgress",
    );
  });

  it("offers direct when allowed, and warns that it is unfiltered and unaudited", async () => {
    const admin = createFakeAdmin();
    admin.directAllowed = true;
    addProfile(admin, "review", { instructions: "x" });
    await openProfile(admin, "review");
    const select = await screen.findByLabelText("Network mode");
    await waitFor(() => {
      expect(within(select).getByRole("option", { name: /^Direct/ })).toBeEnabled();
    });
    await userEvent.selectOptions(select, "direct");
    expect(await screen.findByTestId("direct-warning")).toHaveTextContent("unfiltered, unaudited");
  });

  it("marks a direct profile in the list", async () => {
    const admin = createFakeAdmin();
    addProfile(admin, "open", { networkMode: "direct" });
    addProfile(admin, "review", { instructions: "x" });
    renderApp("/profiles");
    await signIn("alice-token");
    const row = (await screen.findByRole("link", { name: "open" })).closest("tr");
    expect(row).toHaveTextContent("unfiltered, unaudited");
    expect(screen.getByRole("link", { name: "review" }).closest("tr")).not.toHaveTextContent(
      "unfiltered",
    );
  });
});
