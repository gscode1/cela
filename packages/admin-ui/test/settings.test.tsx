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
    expect(screen.getByText("Turn budget", { selector: "td" })).toBeInTheDocument();
    expect(screen.getByText("150", { selector: "td" })).toBeInTheDocument();
    expect(screen.getByText(/from their next message/)).toBeInTheDocument();
    // The old fixed footer line contradicted the budget notes above, which apply to running sessions.
    expect(screen.queryByText("Applies to new sessions only.")).not.toBeInTheDocument();
    expect(screen.queryByText(/revision/i)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(await screen.findByTestId("saved")).toHaveTextContent(/^Settings saved\.$/);
    expect(admin.writes).toHaveLength(1);
    expect(admin.writes[0]?.body).toEqual({
      defaultModel: "scripted/scripted-1",
      allowlist: ["scripted/scripted-1"],
      reasoning: null,
      maxReasoning: null,
      defaultProfile: "coding",
      turnBudget: 150,
      tokenBudget: null,
      repoAllowlist: [],
      expectedRevision: 1,
    });
    expect(screen.queryByText("Review before saving")).not.toBeInTheDocument();
  });

  it("sets a token budget, and clears it back to no limit by sending null", async () => {
    const admin = createFakeAdmin();
    await open(admin);
    const tokens = screen.getByLabelText("Token budget");
    expect(tokens).toHaveValue("");
    await userEvent.type(tokens, "500000");
    expect(screen.getByText("Token budget", { selector: "td" })).toBeInTheDocument();
    expect(screen.getByText("no limit", { selector: "td" })).toBeInTheDocument();
    expect(screen.getByText(/One run can go past it/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await screen.findByTestId("saved");
    expect(admin.writes[0]?.body).toMatchObject({ tokenBudget: 500000 });
    expect(admin.settings.tokenBudget).toBe(500000);

    await userEvent.clear(screen.getByLabelText("Token budget"));
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => {
      expect(admin.writes).toHaveLength(2);
    });
    expect(admin.writes[1]?.body).toMatchObject({ tokenBudget: null });
  });

  it("refuses a token budget that is not a whole number", async () => {
    await open();
    await userEvent.type(screen.getByLabelText("Token budget"), "1.5");
    expect(await screen.findByText(/tokenBudget must be null or an integer/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save settings" })).toBeDisabled();
  });

  it("edits the repo allowlist one entry per line, warns while it is empty, and refuses a bad entry", async () => {
    const admin = createFakeAdmin();
    await open(admin);
    const repos = screen.getByLabelText("Allowed repositories");
    expect(repos).toHaveValue("");
    expect(screen.getByTestId("repo-allowlist-empty")).toHaveTextContent(/refused/);

    await userEvent.type(repos, "acme/he*");
    expect(await screen.findByText(/is not \*, owner\/\* or owner\/name/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save settings" })).toBeDisabled();

    await userEvent.clear(repos);
    await userEvent.type(repos, "Acme/*{Enter}{Enter}  acme/app  {Enter}acme/*");
    expect(screen.queryByTestId("repo-allowlist-empty")).not.toBeInTheDocument();
    expect(screen.getByText("Allowed repositories", { selector: "td" })).toBeInTheDocument();
    expect(screen.getByText(/loses access when its GitHub token next renews/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await screen.findByTestId("saved");
    expect(admin.writes[0]?.body).toMatchObject({ repoAllowlist: ["acme/*", "acme/app"] });
  });

  it("clears reasoning and max reasoning by sending null", async () => {
    const admin = createFakeAdmin();
    admin.settings = { ...admin.settings, reasoning: "low", maxReasoning: "high" };
    await open(admin);
    await waitFor(() => {
      expect(screen.getByLabelText("Default reasoning")).toHaveValue("low");
    });
    await userEvent.selectOptions(screen.getByLabelText("Default reasoning"), "");
    await userEvent.selectOptions(screen.getByLabelText("Highest reasoning allowed"), "");
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
    await userEvent.click(screen.getByRole("button", { name: "Remove scripted-2 (scripted)" }));
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
    expect(screen.queryByText(/not the expected/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Turn budget")).toHaveValue("150");
    expect(admin.settings.turnBudget).toBe(300);

    await userEvent.click(screen.getByRole("button", { name: "Reload and compare" }));
    const compare = await screen.findByTestId("conflict-compare");
    expect(compare).toHaveTextContent(/Changed by carol .* since you opened it/);
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

  it("lists the history one line per entry, newest five first, and expands a line", async () => {
    const admin = createFakeAdmin();
    const entry = (id: string, by: string, old: unknown) => ({
      id,
      changedAt: "2026-11-17T10:00:00.000Z",
      changedBy: by,
      old,
      new: admin.settings,
    });
    admin.history = [
      ...Array.from({ length: 6 }, (_, i) =>
        entry(String(10 - i), "carol", { ...admin.settings, turnBudget: 50 + i }),
      ),
      { ...entry("1", "seed", null), changedAt: "1970-01-01T00:00:00.000Z" },
    ];
    renderApp("/settings");
    await signIn("alice-token");
    const list = await screen.findByRole("list", { name: "Settings history" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(5);
    expect(list).toHaveTextContent("carol changed Turn budget");
    expect(within(list).queryByText("50")).not.toBeInTheDocument();
    await userEvent.click(within(list).getAllByRole("button")[5 - 1] as HTMLElement);
    await userEvent.click(within(list).getAllByRole("button")[0] as HTMLElement);
    expect(within(list).getByText("50", { selector: "td" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(within(list).getAllByRole("listitem")).toHaveLength(7);
    expect(list).toHaveTextContent("built-in set the initial values");
    expect(list).not.toHaveTextContent("1970");
  });

  it("offers only configured models, shows a scripted current value with its note, and round-trips the allowlist", async () => {
    const admin = createFakeAdmin();
    admin.settings = { ...admin.settings, defaultModel: "scripted/scripted-1" };
    await open(admin);
    expect(
      screen.getAllByText(/Test model — replays the message as a script/).length,
    ).toBeGreaterThan(0);
    const provider = screen.getByLabelText("Provider");
    expect(within(provider).queryByText("anthropic")).not.toBeInTheDocument();
    await userEvent.selectOptions(provider, "openai");
    expect(screen.getByLabelText("Default model")).toHaveValue("GPT Fast");
    await userEvent.type(screen.getByLabelText("Add a model"), "think");
    await userEvent.click(screen.getByRole("option", { name: "openai/gpt-think" }));
    expect(within(screen.getByTestId("allowed-models")).getByText("GPT Think")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await screen.findByTestId("saved");
    expect(admin.writes[0]?.body).toMatchObject({
      defaultModel: "openai/gpt-fast",
      allowlist: ["openai/gpt-fast", "scripted/scripted-1", "openai/gpt-think"],
    });
  });

  it("lists only the allowed models, notes the test provider once and never lists the catalog", async () => {
    const admin = createFakeAdmin();
    await open(admin);
    const list = screen.getByTestId("allowed-models");
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(within(list).getByText("default")).toBeInTheDocument();
    expect(within(list).queryByRole("button")).not.toBeInTheDocument();
    expect(
      within(screen.getByRole("group", { name: "Allowed models" })).getAllByText(
        /Test model — replays the message as a script/,
      ),
    ).toHaveLength(1);
    expect(screen.queryByText("GPT Fast")).not.toBeInTheDocument();
  });

  it("lists search matches as provider/id only, and still matches the model name", async () => {
    const admin = createFakeAdmin();
    await open(admin);
    await userEvent.selectOptions(screen.getByLabelText("Provider to add from"), "openai");
    await userEvent.type(screen.getByLabelText("Add a model"), "GPT Think");
    const options = within(screen.getByRole("listbox")).getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual(["openai/gpt-think"]);
  });

  it("hides the scripted test models once a real model is allowed, and keeps them saved", async () => {
    const admin = createFakeAdmin();
    admin.settings = {
      ...admin.settings,
      defaultModel: "openai/gpt-fast",
      allowlist: ["openai/gpt-fast", "scripted/scripted-1", "scripted/scripted-2"],
    };
    await open(admin);
    const list = screen.getByTestId("allowed-models");
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(list).not.toHaveTextContent("scripted");
    expect(
      screen.queryByText(/Test model — replays the message as a script/),
    ).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Add a model"), "think");
    await userEvent.click(screen.getByRole("option", { name: "openai/gpt-think" }));
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await screen.findByTestId("saved");
    expect(admin.writes[0]?.body).toMatchObject({
      allowlist: [
        "openai/gpt-fast",
        "scripted/scripted-1",
        "scripted/scripted-2",
        "openai/gpt-think",
      ],
    });
  });

  it("keeps a 400-model provider short and finds a model by typing", async () => {
    const admin = createFakeAdmin();
    admin.models = {
      ...admin.models,
      models: Array.from({ length: 400 }, (_, index) => ({
        provider: "openai",
        id: `m-${String(index)}`,
        name: `Model ${String(index)}`,
        reasoning: false,
      })),
    };
    await open(admin);
    await userEvent.selectOptions(screen.getByLabelText("Provider to add from"), "openai");
    const add = screen.getByLabelText("Add a model");
    await userEvent.click(add);
    expect(within(screen.getByRole("listbox")).getAllByRole("option")).toHaveLength(20);
    expect(screen.getByText(/380 more/)).toBeInTheDocument();
    await userEvent.type(add, "Model 399");
    await userEvent.keyboard("{Enter}");
    expect(within(screen.getByTestId("allowed-models")).getByText("Model 399")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await screen.findByTestId("saved");
    expect((admin.writes[0]?.body as { allowlist: string[] }).allowlist).toContain("openai/m-399");
  });

  it("says why there is no list, and keeps the current values with a field for a model id", async () => {
    const admin = createFakeAdmin();
    admin.models = {
      models: [],
      providers: [],
      source: "orchestrator",
      filtered: true,
      credentials: "none-configured",
    };
    await waitForOpenNoList(admin);
    expect(
      screen.getByText("No model credentials are configured in OneCLI yet."),
    ).toBeInTheDocument();
    expect(screen.getByTestId("current-model")).toHaveTextContent("scripted/scripted-1");
    await userEvent.type(
      screen.getByLabelText("Enter a model id", { selector: "#default-model-custom" }),
      "openai/typed",
    );
    await userEvent.click(screen.getAllByRole("button", { name: "Use" })[0] as HTMLElement);
    expect(screen.getByTestId("current-model")).toHaveTextContent("openai/typed");
  });

  it("says when OneCLI could not be checked", async () => {
    const admin = createFakeAdmin();
    admin.models = {
      models: [],
      providers: [],
      source: "orchestrator",
      filtered: true,
      credentials: "unknown",
      reason: "no admin key",
    };
    await waitForOpenNoList(admin);
    const notice = screen.getByText("Could not check OneCLI for model credentials.");
    expect(notice).toHaveAttribute("title", "no admin key");
  });
});

async function waitForOpenNoList(admin: FakeAdmin): Promise<void> {
  renderApp("/settings");
  await signIn("alice-token");
  await screen.findByTestId("current-model");
  await waitFor(() => {
    expect(screen.getByLabelText("Default profile")).toHaveValue(admin.settings.defaultProfile);
  });
}
