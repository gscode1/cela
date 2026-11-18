import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useAuth } from "@/auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { addRule, updateRule } from "@/lib/api/egress";
import type { EgressRule, RuleOwner } from "@/lib/api/egress";
import {
  EMPTY_RULE_FORM,
  effectiveRoute,
  formFromRule,
  ruleBody,
  ruleProblems,
  routeLocked,
} from "@/lib/egress-form";
import type { RuleForm as RuleFormState } from "@/lib/egress-form";
import { keys } from "@/lib/queries";
import { useRevisionBase, WriteError } from "@/pages/egress/shared";

/**
 * Add a rule to a set or a session (`rule` undefined) or edit one. The checks mirror the validator so the operator
 * hears about a problem before saving; the API's own message is what shows when it still refuses.
 */
export function RuleForm({
  owner,
  rule,
  revision,
  onClose,
}: {
  owner: RuleOwner;
  rule: EgressRule | undefined;
  /** The schema revision the page showed when this form opened. */
  revision: number;
  onClose: () => void;
}) {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  const editing = rule !== undefined;
  const [form, setForm] = useState<RuleFormState>(rule ? formFromRule(rule) : EMPTY_RULE_FORM);
  const original = rule ? formFromRule(rule) : undefined;
  const base = useRevisionBase(revision);
  const set = (change: Partial<RuleFormState>): void => {
    setForm((current) => ({ ...current, ...change }));
  };
  const problems = ruleProblems(form, new Date(), original);
  const locked = routeLocked(form);
  const save = useMutation({
    mutationFn: () => {
      const body = ruleBody(form, rule);
      return rule
        ? updateRule(token ?? "", rule.id, body, base.base)
        : addRule(token ?? "", owner, body, base.base);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: keys.egress });
      onClose();
    },
  });
  return (
    <Card aria-label={editing ? `Edit rule ${rule.id}` : "Add a rule"}>
      <CardHeader>
        <CardTitle>{editing ? `Edit rule #${rule.id}` : "Add a rule"}</CardTitle>
        <CardDescription>
          Any matching deny wins; otherwise the most specific allow decides: an exact host, then a
          cidr, then a longer suffix, then a shorter one, then <code>*</code>.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex max-w-xl flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="rule-effect">Effect</Label>
              <Select
                id="rule-effect"
                value={form.effect}
                onChange={(event) => {
                  set({ effect: event.target.value === "deny" ? "deny" : "allow" });
                }}
              >
                <option value="allow">Allow</option>
                <option value="deny">Deny</option>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="rule-route">Route</Label>
              <Select
                id="rule-route"
                value={effectiveRoute(form)}
                disabled={locked !== undefined}
                onChange={(event) => {
                  set({ route: event.target.value === "onecli" ? "onecli" : "direct" });
                }}
              >
                <option value="direct">direct</option>
                <option value="onecli">onecli (credentials injected)</option>
              </Select>
              {locked !== undefined && <p className="text-xs text-muted-foreground">{locked}</p>}
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="rule-host">Host</Label>
            <Input
              id="rule-host"
              autoComplete="off"
              value={form.host}
              placeholder="registry.npmjs.org"
              onChange={(event) => {
                set({ host: event.target.value });
              }}
            />
            <p className="text-xs text-muted-foreground">
              <code>registry.npmjs.org</code> (exact), <code>.githubusercontent.com</code> (every
              subdomain, not the bare domain), <code>*</code> (any public host) or, on a private
              rule, a cidr such as <code>10.20.0.0/16</code>.
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="rule-ports">Ports</Label>
            <Input
              id="rule-ports"
              inputMode="numeric"
              autoComplete="off"
              value={form.ports}
              placeholder={form.private ? "required" : "443"}
              onChange={(event) => {
                set({ ports: event.target.value });
              }}
            />
            <p className="text-xs text-muted-foreground">
              Separate with commas. Empty means 443 on a public rule.
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <Checkbox
                id="rule-private"
                checked={form.private}
                onChange={(event) => {
                  set({ private: event.target.checked });
                }}
              />
              <Label htmlFor="rule-private">Private: may reach private and cluster addresses</Label>
            </div>
            <p className="text-xs text-muted-foreground">
              Needs an allow of an exact host or a cidr (at least /8), explicit ports and route
              direct. Loopback, metadata and the platform itself stay blocked.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="rule-expires">Expires</Label>
              <Input
                id="rule-expires"
                type="datetime-local"
                value={form.expiresAt}
                onChange={(event) => {
                  set({ expiresAt: event.target.value });
                }}
              />
              <p className="text-xs text-muted-foreground">Empty: never.</p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="rule-note">Note</Label>
              <Input
                id="rule-note"
                autoComplete="off"
                value={form.note}
                onChange={(event) => {
                  set({ note: event.target.value });
                }}
              />
            </div>
          </div>
          {problems.length > 0 && (
            <ul
              className="list-disc pl-5 text-xs text-muted-foreground"
              data-testid="rule-problems"
            >
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          )}
          {save.isError && <WriteError error={save.error} revision={base} />}
          <div className="flex gap-2">
            <Button type="submit" disabled={problems.length > 0 || save.isPending}>
              {editing ? "Save rule" : "Add rule"}
            </Button>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
