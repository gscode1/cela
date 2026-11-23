import { describe, expect, it } from "vitest";
import type { SessionRef } from "@cela/session-core";
import { planSweep } from "../src/sweep.ts";
import type { SweepInput } from "../src/sweep.ts";

const NOW = Date.parse("2026-11-16T12:00:00Z");
const MIN = 60_000;
const ago = (minutes: number): Date => new Date(NOW - minutes * MIN);

const LIVE = "11111111-1111-4111-8111-111111111111";
const GONE = "22222222-2222-4222-8222-222222222222";
const UNKNOWN = "33333333-3333-4333-8333-333333333333";

const sessions: SessionRef[] = [
  { id: LIVE, status: "active", shard: 0, conversationId: 10 },
  { id: GONE, status: "deleted", shard: 0, conversationId: 20 },
  { id: "44444444-4444-4444-8444-444444444444", status: "deleting", shard: 0, conversationId: 30 },
  { id: "55555555-5555-4555-8555-555555555555", status: "failed", shard: 0, conversationId: 40 },
];

function plan(overrides: Partial<SweepInput>) {
  return planSweep({
    shard: 0,
    sessions,
    claims: [],
    pvcs: [],
    agents: [],
    secrets: [],
    now: NOW,
    graceMs: 10 * MIN,
    maxActions: 100,
    ...overrides,
  });
}

describe("planSweep: claims", () => {
  it("removes a labelled claim whose session is deleted or unknown, and leaves live sessions alone", () => {
    const actions = plan({
      claims: [
        { name: "pi-conv-10", sessionLabel: LIVE, createdAt: ago(60) },
        { name: "pi-conv-20", sessionLabel: GONE, createdAt: ago(60) },
        { name: "pi-conv-50", sessionLabel: UNKNOWN, createdAt: ago(60) },
        {
          name: "pi-conv-30",
          sessionLabel: "44444444-4444-4444-8444-444444444444",
          createdAt: ago(60),
        },
        {
          name: "pi-conv-40",
          sessionLabel: "55555555-5555-4555-8555-555555555555",
          createdAt: ago(60),
        },
      ],
    });
    expect(actions).toEqual([
      { kind: "delete-claim", claim: "pi-conv-20", sessionLabel: GONE, reason: "session-deleted" },
      {
        kind: "delete-claim",
        claim: "pi-conv-50",
        sessionLabel: UNKNOWN,
        reason: "session-unknown",
      },
    ]);
  });

  it("never touches an unlabelled claim, a control-session label or a name outside pi-conv-<n>", () => {
    const actions = plan({
      claims: [
        { name: "e2e-phase1", sessionLabel: undefined, createdAt: ago(600) },
        { name: "pi-conv-60", sessionLabel: undefined, createdAt: ago(600) },
        { name: "pi-conv-61", sessionLabel: "control-61", createdAt: ago(600) },
        { name: "other-claim", sessionLabel: UNKNOWN, createdAt: ago(600) },
        { name: "pi-conv-62x", sessionLabel: UNKNOWN, createdAt: ago(600) },
      ],
    });
    expect(actions).toEqual([]);
  });

  it("respects the grace age: a claim younger than the grace is left for the next run", () => {
    const claim = { name: "pi-conv-50", sessionLabel: UNKNOWN, createdAt: ago(9) };
    expect(plan({ claims: [claim] })).toEqual([]);
    expect(plan({ claims: [{ ...claim, createdAt: ago(10) }] })).toHaveLength(1);
  });
});

describe("planSweep: PVCs", () => {
  it("removes a workspace PVC with no claim when its conversation's session is deleted or unknown", () => {
    const actions = plan({
      pvcs: [
        { name: "workspace-pi-conv-20", createdAt: ago(60) },
        { name: "workspace-pi-conv-99", createdAt: ago(60) },
      ],
    });
    expect(actions).toEqual([
      { kind: "delete-pvc", claim: "pi-conv-20", reason: "session-deleted" },
      { kind: "delete-pvc", claim: "pi-conv-99", reason: "session-unknown" },
    ]);
  });

  it("keeps a PVC that has a claim (labelled or not) and a PVC of a live session", () => {
    const actions = plan({
      claims: [
        { name: "pi-conv-99", sessionLabel: undefined, createdAt: ago(60) },
        { name: "pi-conv-20", sessionLabel: LIVE, createdAt: ago(60) },
      ],
      pvcs: [
        { name: "workspace-pi-conv-99", createdAt: ago(60) },
        { name: "workspace-pi-conv-20", createdAt: ago(60) },
        { name: "workspace-pi-conv-10", createdAt: ago(60) },
      ],
    });
    expect(actions).toEqual([]);
  });

  it("ignores PVCs that are not workspaces of a conversation, and young ones", () => {
    const actions = plan({
      pvcs: [
        { name: "pi-pg-1", createdAt: ago(600) },
        { name: "retired-code-volume", createdAt: ago(600) },
        { name: "e2e-driver", createdAt: ago(600) },
        { name: "workspace-e2e-phase1", createdAt: ago(600) },
        { name: "workspace-pi-conv-99", createdAt: ago(1) },
      ],
    });
    expect(actions).toEqual([]);
  });
});

describe("planSweep: OneCLI agents", () => {
  const agent = (uuid: string) => ({
    id: `a-${uuid.slice(0, 4)}`,
    identifier: `pi-session-${uuid}`,
  });
  const secrets = (uuid: string) => [
    { id: `s1-${uuid.slice(0, 4)}`, name: `pi-session-${uuid}-git` },
    { id: `s2-${uuid.slice(0, 4)}`, name: `pi-session-${uuid}-api` },
  ];

  it("revokes the agent and secrets of a deleted or unknown session, not of a live one", () => {
    const actions = plan({
      agents: [agent(LIVE), agent(GONE), agent(UNKNOWN)],
      secrets: [...secrets(LIVE), ...secrets(GONE), ...secrets(UNKNOWN)],
    });
    expect(actions).toEqual([
      {
        kind: "revoke-agent",
        sessionId: GONE,
        agentIds: ["a-2222"],
        secretIds: ["s1-2222", "s2-2222"],
        reason: "session-deleted",
      },
      {
        kind: "revoke-agent",
        sessionId: UNKNOWN,
        agentIds: ["a-3333"],
        secretIds: ["s1-3333", "s2-3333"],
        reason: "session-unknown",
      },
    ]);
  });

  it("also finds the per-session MCP agent (<prefix><uuid>-m) of a deleted session, and never a discovery agent or a live session's", () => {
    const mcp = (uuid: string) => ({
      id: `m-${uuid.slice(0, 4)}`,
      identifier: `pi-session-${uuid}-m`,
    });
    const actions = plan({
      agents: [
        mcp(LIVE),
        mcp(GONE),
        { id: "d-1", identifier: "pi-session-d-docs" },
        { id: "o-1", identifier: `other-prefix-${GONE}-m` },
      ],
      secrets: [],
    });
    expect(actions).toEqual([
      {
        kind: "revoke-agent",
        sessionId: GONE,
        agentIds: ["m-2222"],
        secretIds: [],
        reason: "session-deleted",
      },
    ]);
  });

  it("finds secrets left behind without their agent", () => {
    const actions = plan({ agents: [], secrets: secrets(GONE) });
    expect(actions).toEqual([
      {
        kind: "revoke-agent",
        sessionId: GONE,
        agentIds: [],
        secretIds: ["s1-2222", "s2-2222"],
        reason: "session-deleted",
      },
    ]);
  });

  it("ignores agents and secrets that do not follow the naming scheme (the orchestrator's own agent, others)", () => {
    const actions = plan({
      agents: [
        { id: "x", identifier: "pi-orchestrator" },
        { id: "y", identifier: "pi-session-not-a-uuid" },
        { id: "z", identifier: `my-pi-session-${UNKNOWN}` },
      ],
      secrets: [
        { id: "k", name: "github-pat" },
        { id: "l", name: `pi-session-${UNKNOWN}-other` },
      ],
    });
    expect(actions).toEqual([]);
  });

  it("never judges an agent or secret of another stack's prefix (a shared OneCLI workspace)", () => {
    const other = "pi-e2e-ab12-";
    const foreign = {
      agents: [{ id: "fa", identifier: `${other}${UNKNOWN}` }],
      secrets: [
        { id: "fs1", name: `${other}${UNKNOWN}-git` },
        { id: "fs2", name: `${other}${UNKNOWN}-api` },
      ],
    };
    // The default prefix does not match a name made with the e2e prefix, in either direction.
    expect(plan(foreign)).toEqual([]);
    const own = { agents: [agent(UNKNOWN)], secrets: secrets(UNKNOWN) };
    expect(plan({ ...own, namePrefix: other })).toEqual([]);
    // A prefix that merely extends another does not match either.
    expect(
      plan({
        agents: [{ id: "x", identifier: `pi-session-ab12cd-${UNKNOWN}` }],
        secrets: [{ id: "y", name: `pi-session-ab12cd-${UNKNOWN}-git` }],
      }),
    ).toEqual([]);
    // With its own prefix the e2e stack judges its own, and only its own.
    const actions = plan({
      agents: [...foreign.agents, agent(UNKNOWN)],
      secrets: [...foreign.secrets, ...secrets(UNKNOWN)],
      namePrefix: other,
    });
    expect(actions).toEqual([
      {
        kind: "revoke-agent",
        sessionId: UNKNOWN,
        agentIds: ["fa"],
        secretIds: ["fs1", "fs2"],
        reason: "session-unknown",
      },
    ]);
  });

  it("judges no agent when OneCLI is not configured", () => {
    expect(plan({ agents: undefined, secrets: secrets(UNKNOWN) })).toEqual([]);
  });

  it("honours the grace age of an agent that reports its creation time", () => {
    const young = { ...agent(UNKNOWN), createdAt: ago(2) };
    expect(plan({ agents: [young] })).toEqual([]);
  });
});

describe("planSweep: bounds", () => {
  it("stops at maxActions and puts claims before PVCs before agents", () => {
    const actions = plan({
      claims: [
        { name: "pi-conv-51", sessionLabel: UNKNOWN, createdAt: ago(60) },
        { name: "pi-conv-52", sessionLabel: UNKNOWN, createdAt: ago(60) },
      ],
      pvcs: [{ name: "workspace-pi-conv-99", createdAt: ago(60) }],
      agents: [{ id: "a", identifier: `pi-session-${UNKNOWN}` }],
      maxActions: 2,
    });
    expect(actions.map((a) => a.kind)).toEqual(["delete-claim", "delete-claim"]);
  });

  it("does nothing when there is nothing to do, and when maxActions is 0", () => {
    expect(plan({})).toEqual([]);
    expect(
      plan({
        claims: [{ name: "pi-conv-51", sessionLabel: UNKNOWN, createdAt: ago(60) }],
        maxActions: 0,
      }),
    ).toEqual([]);
  });
});

describe("planSweep: shards", () => {
  const S1 = "66666666-6666-4666-8666-666666666666";
  const S1_GONE = "77777777-7777-4777-8777-777777777777";
  const mixed: SessionRef[] = [
    ...sessions,
    // Conversation ids repeat across shards: shard 1's conversation 10 is not shard 0's.
    { id: S1, status: "active", shard: 1, conversationId: 10 },
    { id: S1_GONE, status: "deleted", shard: 1, conversationId: 20 },
  ];

  it("judges only the claims and PVCs under its own name prefix", () => {
    const claims = [
      { name: "pi-conv-20", sessionLabel: GONE, createdAt: ago(60) },
      { name: "pi-s1-conv-20", sessionLabel: S1_GONE, createdAt: ago(60) },
    ];
    expect(
      plan({ shard: 0, sessions: mixed, claims }).map((a) => a.kind === "delete-claim" && a.claim),
    ).toEqual(["pi-conv-20"]);
    expect(
      plan({ shard: 1, sessions: mixed, claims }).map((a) => a.kind === "delete-claim" && a.claim),
    ).toEqual(["pi-s1-conv-20"]);
  });

  it("matches a lone PVC to the session of the same shard, not to another shard's conversation id", () => {
    // Shard 1's `pi-s1-conv-10` PVC: conversation 10 of shard 1 is live; shard 0's conversation 10 is live too, but
    // so would the wrong match be for 20 (deleted on both). Use 10: live on both, never an orphan.
    const pvcs = [
      { name: "workspace-pi-s1-conv-10", createdAt: ago(60) },
      { name: "workspace-pi-s1-conv-20", createdAt: ago(60) },
      { name: "workspace-pi-conv-20", createdAt: ago(60) },
    ];
    expect(plan({ shard: 1, sessions: mixed, pvcs })).toEqual([
      { kind: "delete-pvc", claim: "pi-s1-conv-20", reason: "session-deleted" },
    ]);
    expect(plan({ shard: 0, sessions: mixed, pvcs })).toEqual([
      { kind: "delete-pvc", claim: "pi-conv-20", reason: "session-deleted" },
    ]);
  });

  it("does not take another shard's conversation id for its own PVC's session", () => {
    // `workspace-pi-s1-conv-30` on shard 1: shard 1 has no conversation 30 (shard 0 has, and it is live). Unknown.
    const pvcs = [{ name: "workspace-pi-s1-conv-30", createdAt: ago(60) }];
    expect(plan({ shard: 1, sessions: mixed, pvcs })).toEqual([
      { kind: "delete-pvc", claim: "pi-s1-conv-30", reason: "session-unknown" },
    ]);
  });

  it("revokes an agent when its session is deleted and on this shard, or unknown and this is shard 0", () => {
    const agents = [
      { id: "a-gone", identifier: `pi-session-${GONE}`, createdAt: ago(60) },
      { id: "a-s1-gone", identifier: `pi-session-${S1_GONE}`, createdAt: ago(60) },
      { id: "a-unknown", identifier: `pi-session-${UNKNOWN}`, createdAt: ago(60) },
    ];
    const ids = (shard: number) =>
      plan({ shard, sessions: mixed, agents }).flatMap((a) =>
        a.kind === "revoke-agent" ? a.agentIds : [],
      );
    expect(ids(0)).toEqual(["a-gone", "a-unknown"]);
    expect(ids(1)).toEqual(["a-s1-gone"]);
    expect(ids(2)).toEqual([]);
  });
});

describe("planSweep: egress principals", () => {
  const PRINCIPALS = [LIVE, GONE, UNKNOWN, "44444444-4444-4444-8444-444444444444"];

  it("revokes the principal of a deleted or unknown session, not of a live, deleting or failed one", () => {
    const actions = plan({ egressPrincipals: PRINCIPALS });
    expect(actions).toEqual([
      { kind: "revoke-egress", sessionId: GONE, reason: "session-deleted" },
      { kind: "revoke-egress", sessionId: UNKNOWN, reason: "session-unknown" },
    ]);
  });

  it("judges an unknown session on shard 0 only, and another shard's sessions never", () => {
    const other: SessionRef = { id: UNKNOWN, status: "deleted", shard: 1, conversationId: 5 };
    expect(plan({ shard: 1, egressPrincipals: [UNKNOWN, GONE] })).toEqual([]);
    expect(plan({ shard: 0, sessions: [...sessions, other], egressPrincipals: [UNKNOWN] })).toEqual(
      [],
    );
  });

  it("judges nothing when the proxy is off or the listing failed", () => {
    expect(plan({ egressPrincipals: undefined })).toEqual([]);
  });

  it("puts the revocations first, so the action limit cannot cut them behind claim deletions", () => {
    const actions = plan({
      maxActions: 1,
      claims: [{ name: "pi-conv-20", sessionLabel: GONE, createdAt: ago(60) }],
      egressPrincipals: [GONE],
    });
    expect(actions.map((a) => a.kind)).toEqual(["revoke-egress"]);
  });
});
