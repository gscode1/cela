import { describe, expect, it } from "vitest";
import type { SessionRef } from "@pi-durable-k8s/session-core";
import { planSweep } from "../src/sweep.ts";
import type { SweepInput } from "../src/sweep.ts";

const NOW = Date.parse("2026-11-16T12:00:00Z");
const MIN = 60_000;
const ago = (minutes: number): Date => new Date(NOW - minutes * MIN);

const LIVE = "11111111-1111-4111-8111-111111111111";
const GONE = "22222222-2222-4222-8222-222222222222";
const UNKNOWN = "33333333-3333-4333-8333-333333333333";

const sessions: SessionRef[] = [
  { id: LIVE, status: "active", conversationId: 10 },
  { id: GONE, status: "deleted", conversationId: 20 },
  { id: "44444444-4444-4444-8444-444444444444", status: "deleting", conversationId: 30 },
  { id: "55555555-5555-4555-8555-555555555555", status: "failed", conversationId: 40 },
];

function plan(overrides: Partial<SweepInput>) {
  return planSweep({
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
        { name: "orchestrator-code", createdAt: ago(600) },
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
