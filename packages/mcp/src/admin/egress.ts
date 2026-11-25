import { registerGet, registerList, ruleSetName, type AdminContext } from "./context.js";

/** Egress rule sets (`/admin/egress`): reads now; the egress writes come with the dangerous tier (ADR 0070). */
export function registerEgressTools(ctx: AdminContext): void {
  registerList(
    ctx,
    "egress_rule_sets",
    "egress/rule-sets",
    "List egress rule sets with their rule count and whether each applies to all sessions.",
  );
  registerGet(
    ctx,
    "egress_rule_set",
    "egress/rule-sets",
    ruleSetName,
    "Get an egress rule set with its rules.",
  );
}
