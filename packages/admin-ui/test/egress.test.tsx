import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearDrafts } from "@/lib/drafts";
import { createFakeAdmin } from "./fake-admin";
import type { FakeAdmin } from "./fake-admin";
import { addFakeEgress, rule, SESSION } from "./fake-egress";
import type { FakeEgress } from "./fake-egress";
import { renderApp, signIn } from "./render";

afterEach(() => {
  vi.unstubAllGlobals();
  clearDrafts();
});

/** The fake admin API with a profile `scraper` that names the `npm` set, and the egress endpoints. */
function setup(): { admin: FakeAdmin; egress: FakeEgress } {
  const admin = createFakeAdmin();
  admin.profiles.push({
    name: "scraper",
    currentVersion: 1,
    revision: 1,
    enabledForNew: true,
    versions: [{ version: 1, definition: { egressRuleSets: ["npm"] }, createdBy: "alice" }],
  });
  return { admin, egress: addFakeEgress(admin) };
}

async function open(path: string): Promise<void> {
  renderApp(path);
  await signIn("alice-token");
}

const write = (egress: FakeEgress, index = 0) => egress.writes[index];

describe("egress page: rule sets", () => {
  it("has a nav entry and lists the sets with their counts, scope and profiles", async () => {
    setup();
    await open("/settings");
    await userEvent.click(await screen.findByRole("link", { name: "Egress" }));
    const npm = await screen.findByTestId("rule-set-npm");
    expect(within(npm).getByText("1")).toBeInTheDocument();
    expect(within(npm).queryByText("all sessions")).toBeNull();
    expect(within(npm).queryByText("derived")).toBeNull();
    expect(within(npm).getByRole("link", { name: "scraper" })).toHaveAttribute(
      "href",
      "/profiles/scraper",
    );
    const all = screen.getByTestId("rule-set-open-web");
    expect(within(all).getByText("all sessions")).toBeInTheDocument();
  });

  it("shows the revision and the counts from the status endpoint", async () => {
    setup();
    await open("/egress");
    const status = await screen.findByTestId("egress-status");
    await waitFor(() => {
      expect(status).toHaveTextContent("Rules at revision 3: 2 rule sets, 2 rules.");
    });
    expect(status).toHaveTextContent("no egress proxy reports yet");
  });

  it("creates a set with the revision it showed, warning when it applies to all sessions", async () => {
    const { egress } = setup();
    await open("/egress");
    await screen.findByTestId("rule-set-npm");
    await userEvent.click(screen.getByRole("button", { name: "Create a rule set" }));
    const save = screen.getByRole("button", { name: "Create rule set" });
    await userEvent.type(screen.getByLabelText("Name"), "Docs");
    expect(save).toBeDisabled();
    expect(screen.getByText(/Names start with a letter/)).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText("Name"));
    await userEvent.type(screen.getByLabelText("Name"), "docs");
    await userEvent.type(screen.getByLabelText("Description"), "Docs sites");
    expect(screen.queryByTestId("applies-to-all-warning")).toBeNull();
    await userEvent.click(screen.getByLabelText("Applies to all sessions"));
    expect(screen.getByTestId("applies-to-all-warning")).toHaveTextContent(
      "Every session gets these rules",
    );
    await userEvent.click(save);
    await screen.findByTestId("rule-set-docs");
    expect(write(egress)).toEqual({
      path: "POST /admin/egress/rule-sets",
      body: { name: "docs", description: "Docs sites", appliesToAll: true, expectedRevision: 3 },
    });
  });

  it("shows the API's own message when a name exists", async () => {
    setup();
    await open("/egress");
    await screen.findByTestId("rule-set-npm");
    await userEvent.click(screen.getByRole("button", { name: "Create a rule set" }));
    await userEvent.type(screen.getByLabelText("Name"), "npm");
    await userEvent.click(screen.getByRole("button", { name: "Create rule set" }));
    expect(await screen.findByText(/rule set npm already exists/)).toBeInTheDocument();
    // It is not a stale revision: no reload offer.
    expect(screen.queryByTestId("egress-conflict")).toBeNull();
  });

  it("edits the description and warns before a set starts applying to every session", async () => {
    const { egress } = setup();
    await open("/egress");
    await screen.findByTestId("rule-set-npm");
    await userEvent.click(screen.getByRole("button", { name: "Edit npm" }));
    // The form's own "No changes yet." comes before the collapsed history's.
    expect(screen.getAllByText("No changes yet.")[0]).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText("Applies to all sessions"));
    expect(screen.getByTestId("applies-to-all-warning")).toHaveTextContent(
      "Every session gets these rules, not only sessions whose profile names this set. It holds 1 rule now.",
    );
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => {
      expect(screen.getByTestId("rule-set-npm")).toHaveTextContent("all sessions");
    });
    expect(write(egress)).toEqual({
      path: "PUT /admin/egress/rule-sets/npm",
      body: { appliesToAll: true, expectedRevision: 3 },
    });
  });

  it("does not warn when a set stops applying to all", async () => {
    setup();
    await open("/egress");
    await screen.findByTestId("rule-set-open-web");
    await userEvent.click(screen.getByRole("button", { name: "Edit open-web" }));
    await userEvent.click(screen.getByLabelText("Applies to all sessions"));
    expect(screen.queryByTestId("applies-to-all-warning")).toBeNull();
  });

  it("lists the profiles that keep a set from being deleted, and does not offer the delete", async () => {
    const { egress } = setup();
    await open("/egress");
    await screen.findByTestId("rule-set-npm");
    await userEvent.click(screen.getByRole("button", { name: "Delete npm" }));
    const panel = screen.getByRole("generic", { name: "Delete npm" });
    expect(within(panel).getByTestId("delete-blocked-known")).toHaveTextContent("Used by scraper");
    expect(within(panel).getByRole("button", { name: "Delete npm" })).toBeDisabled();
    expect(egress.writes).toEqual([]);
  });

  it("shows the API's blockedBy.profiles when a profile named the set since the page loaded", async () => {
    const { egress } = setup();
    await open("/egress");
    await screen.findByTestId("rule-set-open-web");
    egress.blockProfiles = [{ name: "late", version: 2 }];
    await userEvent.click(screen.getByRole("button", { name: "Delete open-web" }));
    const panel = screen.getByRole("generic", { name: "Delete open-web" });
    expect(panel).toHaveTextContent("lose these rules");
    expect(panel).not.toHaveTextContent("can never be used again");
    await userEvent.type(within(panel).getByLabelText("Type open-web to confirm"), "open-web");
    await userEvent.click(within(panel).getByRole("button", { name: "Delete open-web" }));
    const refused = await screen.findByTestId("delete-refused");
    expect(refused).toHaveTextContent("Not deleted");
    expect(within(refused).getByRole("link", { name: "late" })).toHaveAttribute(
      "href",
      "/profiles/late",
    );
    expect(screen.getByTestId("rule-set-open-web")).toBeInTheDocument();
  });

  it("deletes with the revision once the name is typed", async () => {
    const { egress, admin } = setup();
    admin.profiles.pop();
    await open("/egress");
    await screen.findByTestId("rule-set-npm");
    await userEvent.click(screen.getByRole("button", { name: "Delete npm" }));
    const panel = screen.getByRole("generic", { name: "Delete npm" });
    await userEvent.type(within(panel).getByLabelText("Type npm to confirm"), "npm");
    await userEvent.click(within(panel).getByRole("button", { name: "Delete npm" }));
    await waitFor(() => {
      expect(screen.queryByTestId("rule-set-npm")).toBeNull();
    });
    expect(write(egress)?.path).toBe("DELETE /admin/egress/rule-sets/npm?expectedRevision=3");
  });

  it("asks to reload when another admin changed the rules since the page loaded", async () => {
    const { egress } = setup();
    await open("/egress");
    await screen.findByTestId("rule-set-npm");
    await userEvent.click(screen.getByRole("button", { name: "Create a rule set" }));
    await userEvent.type(screen.getByLabelText("Name"), "docs");
    egress.bump();
    await userEvent.click(screen.getByRole("button", { name: "Create rule set" }));
    const conflict = await screen.findByTestId("egress-conflict");
    expect(conflict).toHaveTextContent("Your input is kept. Nothing was written.");
    expect(egress.ruleSets.some((set) => set.name === "docs")).toBe(false);
    await userEvent.click(within(conflict).getByRole("button", { name: "Reload the rules" }));
    await screen.findByText(/Reloaded\. Save again/);
    expect(screen.getByLabelText("Name")).toHaveValue("docs");
    await userEvent.click(screen.getByRole("button", { name: "Create rule set" }));
    await screen.findByTestId("rule-set-docs");
    expect(egress.writes.map((entry) => entry.body.expectedRevision)).toEqual([3, 4]);
  });
});

describe("egress page: rules of a set", () => {
  it("shows the rules with their fields", async () => {
    const { egress } = setup();
    egress.rules.push(
      rule({
        id: "3",
        host: ".githubusercontent.com",
        ports: [80, 443],
        route: "onecli",
        expiresAt: "2020-01-01T00:00:00.000Z",
        note: "raw files",
      }),
      rule({ id: "4", host: "10.20.0.0/16", ports: [8080], private: true }),
      rule({ id: "5", host: "ads.example.com", effect: "deny" }),
    );
    await open("/egress/sets/npm");
    const row = await screen.findByTestId("rule-3");
    expect(row).toHaveTextContent("allow");
    expect(row).toHaveTextContent(".githubusercontent.com");
    expect(row).toHaveTextContent(":80, 443");
    expect(row).toHaveTextContent("onecli");
    expect(row).toHaveTextContent("expired, ignored");
    expect(row).toHaveTextContent("raw files");
    expect(screen.getByTestId("rule-4")).toHaveTextContent("private");
    expect(screen.getByTestId("rule-5")).toHaveTextContent("deny");
    // The usual rule (443, no expiry, direct) has no filler in its row.
    expect(screen.getByTestId("rule-1")).not.toHaveTextContent("never");
    expect(screen.getByTestId("rule-1")).not.toHaveTextContent(":443");
    expect(screen.getByRole("link", { name: "scraper" })).toBeInTheDocument();
  });

  it("adds a rule and sends the fields the form shows", async () => {
    const { egress } = setup();
    await open("/egress/sets/npm");
    await screen.findByTestId("rule-1");
    await userEvent.click(await screen.findByRole("button", { name: "Add a rule" }));
    await userEvent.type(screen.getByLabelText("Host"), ".githubusercontent.com");
    await userEvent.type(screen.getByLabelText("Ports"), "80, 443");
    await userEvent.selectOptions(screen.getByLabelText("Route"), "onecli");
    await userEvent.type(screen.getByLabelText("Note"), "raw files");
    await userEvent.click(screen.getByRole("button", { name: "Add rule" }));
    await screen.findByTestId("rule-10");
    expect(write(egress)).toEqual({
      path: "POST /admin/egress/rule-sets/npm/rules",
      body: {
        effect: "allow",
        host: ".githubusercontent.com",
        ports: [80, 443],
        route: "onecli",
        private: false,
        expiresAt: null,
        note: "raw files",
        expectedRevision: 3,
      },
    });
  });

  it("validates the form before saving and locks the route where the server forces direct", async () => {
    setup();
    await open("/egress/sets/npm");
    await userEvent.click(await screen.findByRole("button", { name: "Add a rule" }));
    const add = screen.getByRole("button", { name: "Add rule" });
    const problems = () => screen.queryByTestId("rule-problems");
    expect(add).toBeDisabled();
    expect(problems()).toHaveTextContent("the host is required");

    await userEvent.type(screen.getByLabelText("Host"), "*.example.com");
    expect(problems()).toHaveTextContent("no wildcard other than a leading dot");
    expect(add).toBeDisabled();

    await userEvent.clear(screen.getByLabelText("Host"));
    await userEvent.type(screen.getByLabelText("Host"), "*");
    expect(problems()).toBeNull();
    expect(screen.getByLabelText("Route")).toBeDisabled();
    expect(screen.getByText("A * rule is always direct.")).toBeInTheDocument();

    await userEvent.click(screen.getByLabelText(/Private: may reach/));
    expect(problems()).toHaveTextContent("a private rule needs a narrow target");
    expect(problems()).toHaveTextContent("a private rule needs explicit ports");

    await userEvent.clear(screen.getByLabelText("Host"));
    await userEvent.type(screen.getByLabelText("Host"), "10.20.0.0/16");
    await userEvent.type(screen.getByLabelText("Ports"), "8080");
    expect(problems()).toBeNull();
    expect(add).toBeEnabled();

    // A cidr on a public rule is refused.
    await userEvent.click(screen.getByLabelText(/Private: may reach/));
    expect(problems()).toHaveTextContent("a cidr host needs private");

    await userEvent.clear(screen.getByLabelText("Host"));
    await userEvent.type(screen.getByLabelText("Host"), "example.com");
    await userEvent.type(screen.getByLabelText("Ports"), ",99999");
    expect(problems()).toHaveTextContent("ports are from 1 to 65535");
    expect(add).toBeDisabled();
  });

  it("shows the server's 400 message for what the console does not check", async () => {
    setup();
    await open("/egress/sets/npm");
    await userEvent.click(await screen.findByRole("button", { name: "Add a rule" }));
    await userEvent.type(screen.getByLabelText("Host"), "reject.example.com");
    await userEvent.click(screen.getByRole("button", { name: "Add rule" }));
    expect(
      await screen.findByText(/host must be a DNS name of lowercase letters/),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("egress-conflict")).toBeNull();
  });

  it("edits a rule, sending an unchanged expiry back as stored", async () => {
    const { egress } = setup();
    egress.rules.push(
      rule({ id: "3", host: "a.example.com", expiresAt: "2020-01-01T00:00:00.000Z" }),
    );
    await open("/egress/sets/npm");
    await userEvent.click(await screen.findByRole("button", { name: "Edit rule 3" }));
    expect(screen.getByLabelText("Host")).toHaveValue("a.example.com");
    // A kept expiry that has passed is no problem.
    expect(screen.queryByTestId("rule-problems")).toBeNull();
    await userEvent.type(screen.getByLabelText("Note"), "extended");
    await userEvent.click(screen.getByRole("button", { name: "Save rule" }));
    await waitFor(() => {
      expect(screen.getByTestId("rule-3")).toHaveTextContent("extended");
    });
    expect(write(egress)).toEqual({
      path: "PUT /admin/egress/rules/3",
      body: {
        effect: "allow",
        host: "a.example.com",
        ports: [443],
        route: "direct",
        private: false,
        expiresAt: "2020-01-01T00:00:00.000Z",
        note: "extended",
        expectedRevision: 3,
      },
    });
  });

  it("deletes a rule with the revision", async () => {
    const { egress } = setup();
    await open("/egress/sets/npm");
    await userEvent.click(await screen.findByRole("button", { name: "Delete rule 1" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete rule" }));
    await waitFor(() => {
      expect(screen.queryByTestId("rule-1")).toBeNull();
    });
    expect(write(egress)?.path).toBe("DELETE /admin/egress/rules/1?expectedRevision=3");
  });

  it("offers a reload when a rule write is stale, then saves on top of the current rules", async () => {
    const { egress } = setup();
    await open("/egress/sets/npm");
    await userEvent.click(await screen.findByRole("button", { name: "Add a rule" }));
    await userEvent.type(screen.getByLabelText("Host"), "pypi.org");
    egress.bump();
    await userEvent.click(screen.getByRole("button", { name: "Add rule" }));
    const conflict = await screen.findByTestId("egress-conflict");
    expect(conflict).toHaveTextContent("changed since you opened this page");
    // The message names no revision numbers.
    expect(conflict).not.toHaveTextContent("revision 4");
    await userEvent.click(within(conflict).getByRole("button", { name: "Reload the rules" }));
    await screen.findByText(/Reloaded\. Save again/);
    await userEvent.click(screen.getByRole("button", { name: "Add rule" }));
    await screen.findByTestId("rule-10");
    expect(egress.writes.map((entry) => entry.body.expectedRevision)).toEqual([3, 4]);
  });

  it("offers the same reload when a rule delete is stale", async () => {
    const { egress } = setup();
    await open("/egress/sets/npm");
    await userEvent.click(await screen.findByRole("button", { name: "Delete rule 1" }));
    egress.bump();
    await userEvent.click(screen.getByRole("button", { name: "Delete rule" }));
    expect(await screen.findByTestId("egress-conflict")).toBeInTheDocument();
    expect(screen.getByTestId("rule-1")).toBeInTheDocument();
  });
});

describe("egress page: explain", () => {
  const allow = {
    decision: "allow",
    route: "onecli",
    matchedRuleId: "1",
    ruleSet: "npm",
    reason: "allowed by the most specific rule",
    matchedRule: rule({ id: "1", host: "registry.npmjs.org", route: "onecli" }),
    conflictingRules: [],
    host: "registry.npmjs.org",
    port: 443,
    revision: 3,
    profileRuleSets: ["npm"],
    addressesChecked: false,
  };

  async function ask(host: string): Promise<void> {
    await open("/egress/explain");
    await userEvent.type(await screen.findByLabelText("Host"), host);
    await userEvent.click(screen.getByRole("button", { name: "Explain" }));
  }

  it("asks with the port 443 by default and shows decision, route, matched rule and set", async () => {
    const { egress } = setup();
    egress.explainWith = allow;
    await ask("Registry.npmjs.org");
    expect(await screen.findByTestId("explain-decision")).toHaveTextContent("allow");
    expect(egress.explained).toEqual([{ host: "Registry.npmjs.org", port: 443 }]);
    expect(screen.getByTestId("explain-result")).toHaveTextContent("route onecli");
    expect(screen.getByTestId("explain-reason")).toHaveTextContent(
      "allowed by the most specific rule",
    );
    expect(screen.getByTestId("explain-matched")).toHaveTextContent("#1 allow registry.npmjs.org");
    for (const link of screen.getAllByRole("link", { name: "npm" }))
      expect(link).toHaveAttribute("href", "/egress/sets/npm");
    expect(screen.getByText(/not checked: only names were judged/)).toBeInTheDocument();
  });

  it("sends the profile, session and addresses it was given", async () => {
    const { egress } = setup();
    egress.explainWith = { ...allow, addressesChecked: true };
    await open("/egress/explain");
    await userEvent.type(await screen.findByLabelText("Host"), "registry.npmjs.org");
    await userEvent.clear(screen.getByLabelText("Port"));
    await userEvent.type(screen.getByLabelText("Port"), "8443");
    await waitFor(() => {
      expect(within(screen.getByLabelText(/Profile/)).getByText("scraper")).toBeInTheDocument();
    });
    await userEvent.selectOptions(screen.getByLabelText(/Profile/), "scraper");
    await userEvent.type(screen.getByLabelText(/Session id/), SESSION);
    await userEvent.type(screen.getByLabelText(/Addresses/), "10.0.4.7, 93.184.216.34");
    await userEvent.click(screen.getByRole("button", { name: "Explain" }));
    await screen.findByTestId("explain-result");
    expect(egress.explained).toEqual([
      {
        host: "registry.npmjs.org",
        port: 8443,
        profile: "scraper",
        sessionId: SESSION,
        addresses: ["10.0.4.7", "93.184.216.34"],
      },
    ]);
    expect(screen.getByText(/and npm/)).toBeInTheDocument();
  });

  it("shows a deny with the rules whose routes conflict", async () => {
    const { egress } = setup();
    egress.explainWith = {
      ...allow,
      decision: "deny",
      route: null,
      matchedRuleId: null,
      ruleSet: null,
      matchedRule: null,
      reason: "conflicting routes",
      conflictingRules: [
        rule({ id: "1", host: "api.github.com", route: "direct" }),
        rule({ id: "9", ruleSet: "github-public", host: "api.github.com", route: "onecli" }),
      ],
    };
    await ask("api.github.com");
    expect(await screen.findByTestId("explain-decision")).toHaveTextContent("deny");
    const conflict = screen.getByTestId("explain-conflict");
    expect(conflict).toHaveTextContent("#1 allow api.github.com");
    expect(conflict).toHaveTextContent("#9 allow api.github.com");
    expect(conflict).toHaveTextContent("onecli");
    expect(within(conflict).getByRole("link", { name: "github-public" })).toBeInTheDocument();
  });

  it("shows the hint that a private address needs a private rule", async () => {
    const { egress } = setup();
    egress.explainWith = {
      ...allow,
      decision: "deny",
      route: null,
      matchedRuleId: null,
      ruleSet: null,
      matchedRule: null,
      needsPrivate: true,
      reason: "resolves to a private address; it needs an allow rule with `private: true`",
      addressesChecked: true,
    };
    await ask("billing.internal");
    expect(await screen.findByTestId("explain-needs-private")).toHaveTextContent(
      "only an allow rule with private can open it",
    );
  });

  it("shows the API's 400 for a host it refuses", async () => {
    setup();
    await ask("bad host");
    expect(await screen.findByText("host must be a DNS name")).toBeInTheDocument();
  });

  it("checks the port and the session id before asking", async () => {
    const { egress } = setup();
    await open("/egress/explain");
    await userEvent.type(await screen.findByLabelText("Host"), "a.example.com");
    await userEvent.clear(screen.getByLabelText("Port"));
    await userEvent.type(screen.getByLabelText("Port"), "70000");
    await userEvent.type(screen.getByLabelText(/Session id/), "nope");
    expect(screen.getByRole("button", { name: "Explain" })).toBeDisabled();
    expect(screen.getByText("the port is from 1 to 65535")).toBeInTheDocument();
    expect(screen.getByText("a session id is a lowercase UUID")).toBeInTheDocument();
    expect(egress.explained).toEqual([]);
  });
});

describe("egress page: session rules and history", () => {
  it("lists, adds and deletes the rules of a session", async () => {
    const { egress } = setup();
    egress.rules.push(
      rule({ id: "7", ruleSet: null, sessionId: SESSION, host: "github.com", route: "onecli" }),
    );
    await open("/egress/session-rules");
    await userEvent.type(await screen.findByLabelText("Session id"), "nope");
    expect(screen.getByRole("button", { name: "Show rules" })).toBeDisabled();
    expect(screen.getByText("A session id is a lowercase UUID.")).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText("Session id"));
    await userEvent.type(screen.getByLabelText("Session id"), SESSION);
    await userEvent.click(screen.getByRole("button", { name: "Show rules" }));
    expect(await screen.findByTestId("rule-7")).toHaveTextContent("github.com");
    // The rules of sets are not shown here.
    expect(screen.queryByTestId("rule-1")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Add a rule" }));
    await userEvent.type(screen.getByLabelText("Host"), "api.example.com");
    await userEvent.click(screen.getByRole("button", { name: "Add rule" }));
    await screen.findByTestId("rule-10");
    expect(write(egress)?.path).toBe(`POST /admin/egress/sessions/${SESSION}/rules`);
    expect(write(egress)?.body.expectedRevision).toBe(3);

    await userEvent.click(screen.getByRole("button", { name: "Delete rule 7" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete rule" }));
    await waitFor(() => {
      expect(screen.queryByTestId("rule-7")).toBeNull();
    });
    expect(egress.writes[1]?.path).toBe("DELETE /admin/egress/rules/7?expectedRevision=4");
  });

  it("shows recent changes as sentences", async () => {
    const { egress } = setup();
    egress.history = [
      {
        id: "2",
        revision: 3,
        changedAt: "2026-11-17T00:00:00.000Z",
        changedBy: "alice",
        kind: "rule",
        ref: "7",
        action: "create",
        old: null,
        new: {
          ruleSet: "npm",
          sessionId: null,
          effect: "allow",
          host: "a.example.com",
          ports: [443],
          route: "direct",
          private: false,
          expiresAt: null,
          note: "",
        },
      },
      {
        id: "1",
        revision: 2,
        changedAt: "2026-11-16T00:00:00.000Z",
        changedBy: "bob",
        kind: "rule-set",
        ref: "docs",
        action: "create",
        old: null,
        new: { description: "Docs", appliesToAll: false },
      },
    ];
    await open("/egress");
    const entries = await screen.findAllByTestId("egress-history-entry");
    expect(entries[0]).toHaveTextContent(
      "created rule #7 in npm: allow a.example.com ports 443 via direct",
    );
    expect(entries[0]).toHaveTextContent("by alice");
    expect(entries[1]).toHaveTextContent(
      'created rule set docs: "Docs", only where a profile names it',
    );
  });
});

describe("profile editor: egress rule sets", () => {
  async function openProfile(name: string): Promise<void> {
    await open(`/profiles/${name}`);
    await screen.findByRole("heading", { name: new RegExp(`Edit ${name}`) });
  }

  it("lists the sets and marks the ones that apply to all sessions as already included", async () => {
    setup();
    await openProfile("coding");
    const group = await screen.findByRole("group", { name: "Egress rule sets" });
    await waitFor(() => {
      expect(within(group).getByLabelText("npm")).toBeInTheDocument();
    });
    expect(within(group).getByLabelText("npm")).toBeEnabled();
    expect(within(group).getByLabelText("open-web")).toBeDisabled();
    expect(
      within(group).getByText(/Already included: applies to all sessions/),
    ).toBeInTheDocument();
  });

  it("publishes the chosen sets as egressRuleSets, and shows the change and what it means", async () => {
    const { admin } = setup();
    await openProfile("coding");
    const group = await screen.findByRole("group", { name: "Egress rule sets" });
    await userEvent.click(await within(group).findByLabelText("npm"));
    expect(screen.getByText("Egress rule sets", { selector: "td" })).toBeInTheDocument();
    expect(screen.getByText("npm", { selector: "td" })).toBeInTheDocument();
    expect(
      screen.getByText(/A running session keeps the rule sets of the version it started with/),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Publish new version" }));
    await screen.findByText(/Published version 2 of coding/);
    expect(admin.writes[0]).toEqual({
      path: "/admin/profiles/coding",
      body: { definition: { egressRuleSets: ["npm"] }, expectedRevision: 1 },
    });
  });

  it("shows a deleted set with a way to drop it", async () => {
    const admin = createFakeAdmin();
    addFakeEgress(admin);
    admin.profiles[0]?.versions.push({
      version: 2,
      definition: { egressRuleSets: ["gone"] },
      createdBy: "alice",
    });
    if (admin.profiles[0] !== undefined) admin.profiles[0].currentVersion = 2;
    await openProfile("coding");
    const missing = await screen.findByTestId("missing-rule-set");
    expect(missing).toHaveTextContent("gone");
    await userEvent.click(within(missing).getByRole("button", { name: "Remove gone" }));
    expect(screen.queryByTestId("missing-rule-set")).toBeNull();
    expect(screen.getByText("gone", { selector: "td" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Publish new version" }));
    await screen.findByText(/Published version 3 of coding/);
    expect(admin.writes[0]?.body).toEqual({
      definition: { egressRuleSets: [] },
      expectedRevision: 1,
    });
  });
});
