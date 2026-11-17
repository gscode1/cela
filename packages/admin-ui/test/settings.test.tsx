import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearDrafts } from "@/lib/drafts";
import { createFakeAdmin } from "./fake-admin";
import type { FakeAdmin } from "./fake-admin";
import { renderApp, signIn } from "./render";

afterEach(() => {
  vi.unstubAllGlobals();
  clearDrafts();
});

async function open(admin: FakeAdmin = createFakeAdmin()): Promise<FakeAdmin> {
  renderApp("/settings");
  await signIn("alice-token");
  await screen.findByLabelText("Default model");
  await waitFor(() => {
    expect(screen.getByLabelText("Default profile")).toHaveValue(admin.settings.defaultProfile);
  });
  return admin;
}

describe("settings editor", () => {
  it("shows previous and new values before saving, then saves every field with the revision", async () => {
    const admin = createFakeAdmin();
    await open(admin);
    expect(screen.queryByText("Review before saving")).not.toBeInTheDocument();

    const budget = screen.getByLabelText("Turn budget");
    await userEvent.clear(budget);
    await userEvent.type(budget, "150");
    const review = screen.getByText("Review before saving").closest("div");
    expect(review).not.toBeNull();
    expect(screen.getByText("turnBudget")).toBeInTheDocument();
    expect(screen.getByText("150", { selector: "td" })).toBeInTheDocument();
    expect(screen.getByText(/applies to sessions that inherit it/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await screen.findByTestId("saved");
    expect(admin.writes).toHaveLength(1);
    expect(admin.writes[0]?.body).toEqual({
      defaultModel: "scripted/scripted-1",
      allowlist: ["scripted/scripted-1"],
      reasoning: null,
      maxReasoning: null,
      defaultProfile: "coding",
      turnBudget: 150,
      expectedRevision: 1,
    });
    expect(screen.queryByText("Review before saving")).not.toBeInTheDocument();
  });

  it("clears reasoning and max reasoning by sending null", async () => {
    const admin = createFakeAdmin();
    admin.settings = { ...admin.settings, reasoning: "low", maxReasoning: "high" };
    await open(admin);
    await waitFor(() => {
      expect(screen.getByLabelText("Reasoning")).toHaveValue("low");
    });
    await userEvent.selectOptions(screen.getByLabelText("Reasoning"), "not set");
    await userEvent.selectOptions(screen.getByLabelText("Max reasoning"), "not set");
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await screen.findByTestId("saved");
    expect(admin.writes[0]?.body).toMatchObject({ reasoning: null, maxReasoning: null });
  });

  it("blocks a save that makes the default profile fail admission, and only warns for the others", async () => {
    const admin = createFakeAdmin();
    admin.settings = {
      ...admin.settings,
      allowlist: ["scripted/scripted-1", "scripted/scripted-2"],
    };
    admin.profiles.push({
      name: "fast",
      currentVersion: 1,
      revision: 1,
      enabledForNew: true,
      versions: [
        { version: 1, definition: { defaultModel: "scripted/scripted-2" }, createdBy: "alice" },
      ],
    });
    await open(admin);
    await waitFor(() => {
      expect(
        within(screen.getByLabelText("Default profile")).getByText("fast"),
      ).toBeInTheDocument();
    });
    // Dropping scripted-2 breaks "fast", which is not the default: a warning.
    const list = screen.getByLabelText("Allowlist");
    await userEvent.clear(list);
    await userEvent.type(list, "scripted/scripted-1");
    expect(await screen.findByTestId("warnings")).toHaveTextContent("fast");
    expect(screen.getByRole("button", { name: "Save settings" })).toBeEnabled();

    // Selecting it as the default is a block.
    await userEvent.selectOptions(screen.getByLabelText("Default profile"), "fast");
    expect(await screen.findByTestId("blocking")).toHaveTextContent(
      "model scripted/scripted-2 is not allowed",
    );
    expect(screen.getByRole("button", { name: "Save settings" })).toBeDisabled();
  });

  it("flags a stored default that is disabled, with the fix", async () => {
    const admin = createFakeAdmin();
    admin.profiles[0] = {
      ...(admin.profiles[0] as FakeAdmin["profiles"][number]),
      enabledForNew: false,
    };
    renderApp("/settings");
    await signIn("alice-token");
    expect(await screen.findByTestId("default-problem")).toHaveTextContent(
      'the default profile "coding" is not available for new sessions',
    );
  });

  it("keeps the draft on a 409, then compares with the server and keeps editing on top of it", async () => {
    const admin = createFakeAdmin();
    await open(admin);
    const budget = screen.getByLabelText("Turn budget");
    await userEvent.clear(budget);
    await userEvent.type(budget, "150");

    // Another admin saved in the meantime.
    admin.settings = { ...admin.settings, turnBudget: 300, revision: 2, updatedBy: "carol" };
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(await screen.findByText(/Not saved: the settings changed/)).toBeInTheDocument();
    expect(screen.getByText(/revision 2, not the expected 1/)).toBeInTheDocument();
    expect(screen.getByLabelText("Turn budget")).toHaveValue("150");
    expect(admin.settings.turnBudget).toBe(300);

    await userEvent.click(screen.getByRole("button", { name: "Reload and compare" }));
    const compare = await screen.findByTestId("conflict-compare");
    expect(compare).toHaveTextContent("revision 2, changed by carol");
    expect(within(compare).getByText("300")).toBeInTheDocument();
    expect(within(compare).getByText("150")).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: "Keep my draft on top of the server version" }),
    );
    expect(screen.getByLabelText("Turn budget")).toHaveValue("150");
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await screen.findByTestId("saved");
    expect(admin.writes.at(-1)?.body).toMatchObject({ turnBudget: 150, expectedRevision: 2 });
    expect(admin.settings.turnBudget).toBe(150);
  });

  it("shows who changed what in the history", async () => {
    const admin = createFakeAdmin();
    admin.history = [
      {
        id: "2",
        changedAt: "2026-11-17T10:00:00.000Z",
        changedBy: "carol",
        old: { ...admin.settings, turnBudget: 50 },
        new: admin.settings,
      },
    ];
    renderApp("/settings");
    await signIn("alice-token");
    const list = await screen.findByRole("list", { name: "Settings history" });
    expect(list).toHaveTextContent("carol");
    expect(list).toHaveTextContent("2026-11-17T10:00:00.000Z");
    expect(within(list).getByText("50")).toBeInTheDocument();
  });
});
