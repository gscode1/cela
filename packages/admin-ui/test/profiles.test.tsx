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
    expect(coding).toHaveTextContent("v1");
    expect(coding).toHaveTextContent("enabled");
    expect(within(table).getByRole("link", { name: "review" }).closest("tr")).toHaveTextContent(
      "disabled",
    );
    expect(screen.getByTestId("invalid-profile")).toHaveTextContent(
      "stored profile broken is invalid",
    );
  });
});

describe("profile editor", () => {
  it("publishes a new version with the revision, and sends an omitted tools list as omitted", async () => {
    const admin = createFakeAdmin();
    await openProfile(admin, "coding");
    await userEvent.type(screen.getByLabelText("Instructions"), "Be brief.");
    expect(screen.getByText("instructions", { selector: "td" })).toBeInTheDocument();
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
      expect(screen.getByLabelText("Reasoning")).toHaveValue("off");
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
    await userEvent.selectOptions(screen.getByLabelText("Reasoning"), "global default");
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
    await userEvent.click(screen.getByLabelText("All (field omitted)", { selector: "#tools-all" }));
    // Switching to an explicit list starts from every installed tool: the same effective set, but now spelled out.
    expect(screen.getByLabelText("bash", { selector: "#tools-bash" })).toBeChecked();
    for (const tool of ["read", "write", "edit", "bash"])
      await userEvent.click(screen.getByLabelText(tool, { selector: `#tools-${tool}` }));
    expect(screen.getByText("No tools: an empty list.")).toBeInTheDocument();
    expect(screen.getByText("(empty list)")).toBeInTheDocument();
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
    await userEvent.click(screen.getByLabelText("All (field omitted)", { selector: "#tools-all" }));
    await userEvent.click(screen.getByLabelText("read", { selector: "#tools-read" }));
    await userEvent.click(screen.getByLabelText("bash", { selector: "#tools-bash" }));
    await waitFor(() => {
      expect(within(screen.getByLabelText("Skill")).getByText("lint")).toBeInTheDocument();
    });
    await userEvent.selectOptions(screen.getByLabelText("Skill"), "lint");
    await userEvent.click(screen.getByRole("button", { name: "Pin version" }));
    expect(await screen.findByTestId("skill-pin")).toHaveTextContent("lint@v1");
    expect(screen.getByTestId("skill-pin")).toHaveTextContent("executable files");
    expect(screen.getByTestId("read-dependency")).toHaveTextContent("Add read");
    expect(
      screen.getByText("skills need the read tool, but tools does not include it"),
    ).toBeInTheDocument();
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
    expect(screen.getByText(/disabled: its tools are unavailable/)).toBeInTheDocument();
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
      expect(screen.getByRole("region", { name: "Admission preview" })).toHaveTextContent(
        "scripted/scripted-1 (from the global settings)",
      );
    });
    await userEvent.selectOptions(screen.getByLabelText("Reasoning"), "high");
    expect(screen.getByRole("region", { name: "Admission preview" })).toHaveTextContent(
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
      expect(screen.getByLabelText("Reasoning")).toBeEnabled();
    });
    await userEvent.selectOptions(screen.getByLabelText("Reasoning"), "high");
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

  it("shows the API's 409 and the fix when disabling the default profile", async () => {
    const admin = createFakeAdmin();
    await openProfile(admin, "coding");
    await userEvent.click(screen.getByRole("button", { name: "Disable for new sessions" }));
    const conflict = await screen.findByTestId("toggle-conflict");
    expect(conflict).toHaveTextContent('profile "coding" is the default profile for new sessions');
    expect(conflict).toHaveTextContent(
      "select another enabled profile as the default in Global settings",
    );
    expect(admin.profiles[0]?.enabledForNew).toBe(true);
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
  it("diffs two stored definitions, omitted against empty", async () => {
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
    expect(diff).toHaveTextContent("tools(omitted)(empty list)");
    expect(diff).toHaveTextContent("reasoning(omitted)off");
    const list = screen.getByRole("list", { name: "Version list" });
    expect(list).toHaveTextContent("carol");
    expect(list).toHaveTextContent("current");
  });
});

describe("create", () => {
  it("creates a profile without expectedRevision and refuses an existing name", async () => {
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
      body: { definition: { instructions: "Review code." } },
    });
  });
});
