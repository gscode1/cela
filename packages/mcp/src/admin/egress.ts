import { z } from "zod";
import {
  destructiveAnnotations,
  MAX_REVISION,
  readAnnotations,
  registerGet,
  registerList,
  ruleSetName,
  untrusted,
  type AdminContext,
} from "./context.js";

/*
 * The limits below are session-core's (`egress-rules.ts`, the validator of ingest) written out, because this package does
 * not depend on session-core at run time; a test compares them with its exports. Ingest stays the validator: these only
 * keep a bad call from being sent.
 */

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RULE_ID = /^[1-9][0-9]{0,17}$/;
const EXPIRES_AT = /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/;
export const MAX_NOTE = 500;
export const MAX_DESCRIPTION = 500;
export const MAX_PORTS = 32;

const sessionId = z.string().regex(SESSION_ID).describe("Session id (a lowercase UUID).");

/** The fields of a rule besides its owner, as in session-core's `EgressRuleSpec` (a test keeps them equal). */
export const EGRESS_RULE_SHAPE = {
  effect: z
    .enum(["allow", "deny"])
    .optional()
    .describe("allow or deny. Required for a new rule. Any matching deny wins over an allow."),
  host: z
    .string()
    .min(1)
    .max(253)
    .optional()
    .describe(
      "Required for a new rule. An exact host (registry.npmjs.org), a suffix with a leading dot (.githubusercontent.com: subdomains only), * (any host; direct only) or, on a private rule, a cidr (10.20.0.0/16).",
    ),
  ports: z
    .array(z.number().int().min(1).max(65535))
    .min(1)
    .max(MAX_PORTS)
    .optional()
    .describe("1 to 32 ports. Default [443]; a private rule must give them."),
  route: z
    .enum(["direct", "onecli"])
    .optional()
    .describe(
      "direct (default) or onecli (credential injection; an allow of a named public host only).",
    ),
  private: z
    .boolean()
    .optional()
    .describe(
      "An allow that may reach a private or cluster address: needs an exact host or a cidr, explicit ports and route direct. Default false.",
    ),
  expiresAt: z
    .string()
    .regex(EXPIRES_AT)
    .nullable()
    .optional()
    .describe("ISO 8601 timestamp with a time zone, in the future; null for never."),
  note: z.string().max(MAX_NOTE).optional().describe("Free text, up to 500 characters."),
};

/** The fields of a rule set besides its name, as in session-core's `RuleSetSpec` (a test keeps them equal). */
export const EGRESS_RULE_SET_SHAPE = {
  description: z.string().max(MAX_DESCRIPTION).optional().describe("Up to 500 characters."),
  appliesToAll: z
    .boolean()
    .optional()
    .describe("The set applies to every session, not only to profiles that name it."),
};

const revisionNote =
  "The egress revision: one number for all rule sets and rules together, as in admin_list_egress_rule_sets or admin_get_egress_status. Any egress write changes it, so reload and retry on 409.";
const expectedRevision = z.number().int().min(1).max(MAX_REVISION).describe(revisionNote);
const expectedRevisionOrCreate = z
  .number()
  .int()
  .min(0)
  .max(MAX_REVISION)
  .describe(`${revisionNote} 0 only while no egress write has happened yet.`);

const putRuleFields = z.object({
  id: z
    .string()
    .regex(RULE_ID)
    .optional()
    .describe("Rule id to update (partial: omitted fields keep their value). Absent: create."),
  ruleSet: ruleSetName
    .optional()
    .describe("Create only: the rule set the new rule belongs to (not with sessionId)."),
  sessionId: sessionId
    .optional()
    .describe("Create only: the session the new rule belongs to (not with ruleSet)."),
  expectedRevision: expectedRevisionOrCreate,
  ...EGRESS_RULE_SHAPE,
});

/** What `admin_put_egress_rule` takes: an update names the rule, a create names exactly one owner and has effect and host. */
export const putRuleInput = putRuleFields.superRefine((args, ctx) => {
  const issue = (message: string): void => {
    ctx.addIssue({ code: "custom", message });
  };
  if (args.id !== undefined) {
    if (args.ruleSet !== undefined || args.sessionId !== undefined)
      issue("a rule's owner never changes: omit ruleSet and sessionId when id is given");
    return;
  }
  if ((args.ruleSet === undefined) === (args.sessionId === undefined))
    issue("to create a rule give exactly one of ruleSet and sessionId (or id to update one)");
  if (args.effect === undefined || args.host === undefined)
    issue("effect and host are required to create a rule");
});

/** Egress (`/admin/egress`): reads, and the dangerous tier's writes (ADR 0034, 0070). */
export function registerEgressTools(ctx: AdminContext): void {
  registerList(
    ctx,
    "egress_rule_sets",
    "egress/rule-sets",
    "List egress rule sets with their rule count and whether each applies to all sessions; revision is the egress revision the writes need.",
  );
  registerGet(
    ctx,
    "egress_rule_set",
    "egress/rule-sets",
    ruleSetName,
    "Get an egress rule set with its rules.",
  );
  ctx.server.registerTool(
    "admin_get_egress_status",
    {
      description: `Egress status: the revision, rule and rule set counts, session token counts and what each proxy replica last reported (a change has arrived when every serving replica shows its revision). ${untrusted}`,
      inputSchema: z.object({}),
      annotations: readAnnotations,
    },
    async (_args, extra) => ctx.call("GET", "/admin/egress/status", extra.mcpReq.signal),
  );
  ctx.server.registerTool(
    "admin_list_session_egress_rules",
    {
      description: `List the egress rules of one session (temporary, per session), with the egress revision and the session's network mode. ${untrusted}`,
      inputSchema: z.object({ sessionId }),
      annotations: readAnnotations,
    },
    async (args, extra) =>
      ctx.call("GET", `/admin/egress/sessions/${args.sessionId}/rules`, extra.mcpReq.signal),
  );
  ctx.server.registerTool(
    "admin_explain_egress",
    {
      description: `Explain why a connection to host and port would be allowed or denied, and by which rule. Changes nothing (a POST, but pure). sessionId adds that session's rules and its profile's rule sets; profile resolves a profile's. Without addresses only names are judged: whether the host resolves to a private address is not (addressesChecked false); pass addresses to judge those. ${untrusted}`,
      inputSchema: z.object({
        host: z.string().min(1).max(300).describe("Host name to judge."),
        port: z.number().int().min(1).max(65535).optional().describe("Default 443."),
        sessionId: sessionId.optional(),
        profile: z
          .string()
          .regex(/^[a-z][a-z0-9-]{0,31}$/)
          .optional()
          .describe("Profile name whose rule sets apply."),
        addresses: z
          .array(z.string().max(64))
          .max(16)
          .optional()
          .describe(
            "IP addresses the host is assumed to resolve to (no DNS lookup is made); judged against the blocked and private ranges.",
          ),
      }),
      annotations: readAnnotations,
    },
    async (args, extra) => ctx.call("POST", "/admin/egress/explain", extra.mcpReq.signal, args),
  );
  if (!ctx.tiers.dangerous) return;
  ctx.server.registerTool(
    "admin_put_egress_rule_set",
    {
      description: `Create or update an egress rule set. create true makes a new one (409 if the name exists); otherwise it updates the existing set, and fields you omit keep their value. A set with appliesToAll true changes what every session can reach. ${untrusted}`,
      inputSchema: z.object({
        name: ruleSetName,
        expectedRevision: expectedRevisionOrCreate,
        ...EGRESS_RULE_SET_SHAPE,
        create: z.boolean().optional().describe("true to create the set; default false (update)."),
      }),
      annotations: destructiveAnnotations,
    },
    async ({ name, create, ...body }, extra) =>
      create === true
        ? ctx.call("POST", "/admin/egress/rule-sets", extra.mcpReq.signal, { name, ...body })
        : ctx.call(
            "PUT",
            `/admin/egress/rule-sets/${encodeURIComponent(name)}`,
            extra.mcpReq.signal,
            body,
          ),
  );
  ctx.server.registerTool(
    "admin_delete_egress_rule_set",
    {
      description: `Delete an egress rule set and its rules (the history keeps them). 409 while a profile names it. ${untrusted}`,
      inputSchema: z.object({ name: ruleSetName, expectedRevision }),
      annotations: destructiveAnnotations,
    },
    async (args, extra) =>
      ctx.call(
        "DELETE",
        `/admin/egress/rule-sets/${encodeURIComponent(args.name)}?expectedRevision=${String(args.expectedRevision)}`,
        extra.mcpReq.signal,
      ),
  );
  ctx.server.registerTool(
    "admin_put_egress_rule",
    {
      description: `Create or update an egress rule. With id it updates that rule (partial). Without id it creates one in exactly one of ruleSet and sessionId, and needs effect and host. An allow opens what sandboxes can reach; private rules open internal addresses. ${untrusted}`,
      inputSchema: putRuleInput,
      annotations: destructiveAnnotations,
    },
    async ({ id, ruleSet, sessionId: session, ...body }, extra) => {
      if (id !== undefined)
        return ctx.call("PUT", `/admin/egress/rules/${id}`, extra.mcpReq.signal, body);
      const base =
        ruleSet === undefined
          ? `/admin/egress/sessions/${session ?? ""}`
          : `/admin/egress/rule-sets/${encodeURIComponent(ruleSet)}`;
      return ctx.call("POST", `${base}/rules`, extra.mcpReq.signal, body);
    },
  );
  ctx.server.registerTool(
    "admin_delete_egress_rule",
    {
      description: `Delete an egress rule by id. A tunnel it allowed is closed within a poll. ${untrusted}`,
      inputSchema: z.object({
        id: z.string().regex(RULE_ID).describe("Rule id."),
        expectedRevision,
      }),
      annotations: destructiveAnnotations,
    },
    async (args, extra) =>
      ctx.call(
        "DELETE",
        `/admin/egress/rules/${args.id}?expectedRevision=${String(args.expectedRevision)}`,
        extra.mcpReq.signal,
      ),
  );
}
