import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useAuth } from "@/auth";
import { Time } from "@/components/time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, Td, Th } from "@/components/ui/table";
import { deleteRule } from "@/lib/api/egress";
import type { EgressRule, RuleOwner } from "@/lib/api/egress";
import { isExpired, portsText } from "@/lib/egress-form";
import { keys } from "@/lib/queries";
import { RuleForm } from "@/pages/egress/rule-form";
import { EffectBadge, useRevisionBase, WriteError } from "@/pages/egress/shared";

type Pending = { kind: "add" } | { kind: "edit" | "delete"; rule: EgressRule };

export function HostText({ host }: { host: string }) {
  return host === "*" ? (
    <span>
      <code>*</code> <span className="text-muted-foreground">(any public host)</span>
    </span>
  ) : (
    <code className="break-all">{host}</code>
  );
}

function DeleteRulePanel({
  rule,
  revision,
  onClose,
}: {
  rule: EgressRule;
  revision: number;
  onClose: () => void;
}) {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  const base = useRevisionBase(revision);
  const remove = useMutation({
    mutationFn: () => deleteRule(token ?? "", rule.id, base.base),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: keys.egress });
      onClose();
    },
  });
  return (
    <Card aria-label={`Delete rule ${rule.id}`}>
      <CardHeader>
        <CardTitle>Delete rule #{rule.id}?</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm">
          This removes the {rule.effect} rule for <code>{rule.host}</code>. The history keeps it.
        </p>
        {remove.isError && <WriteError error={remove.error} revision={base} />}
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
          >
            Delete rule
          </Button>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * The rules of a set or a session: a table with add, edit and delete. `revision` is the revision of the whole egress
 * schema (undefined while it loads, so no write starts on a guess).
 */
export function RuleManager({
  owner,
  rules,
  revision,
}: {
  owner: RuleOwner;
  rules: EgressRule[];
  revision: number | undefined;
}) {
  const [pending, setPending] = useState<Pending | undefined>(undefined);
  const close = (): void => {
    setPending(undefined);
  };
  const ready = revision !== undefined;
  return (
    <div className="flex flex-col gap-3">
      {pending === undefined && (
        <div>
          <Button size="sm" disabled={!ready} onClick={() => setPending({ kind: "add" })}>
            Add a rule
          </Button>
        </div>
      )}
      {rules.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No rules yet: nothing is allowed by this one.
        </p>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Effect</Th>
              <Th>Host</Th>
              <Th>Ports</Th>
              <Th>Route</Th>
              <Th>Private</Th>
              <Th>Expires</Th>
              <Th>Note</Th>
              <Th>
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {rules.map((rule) => (
              <tr key={rule.id} data-testid={`rule-${rule.id}`}>
                <Td>
                  <EffectBadge effect={rule.effect} />
                </Td>
                <Td>
                  <HostText host={rule.host} />
                </Td>
                <Td>{portsText(rule.ports)}</Td>
                <Td>{rule.effect === "allow" ? rule.route : "—"}</Td>
                <Td>{rule.private ? <Badge variant="warning">private</Badge> : "—"}</Td>
                <Td>
                  {rule.expiresAt === null ? (
                    <span className="text-muted-foreground">never</span>
                  ) : (
                    <span className="flex flex-wrap items-center gap-1">
                      <Time value={rule.expiresAt} />
                      {isExpired(rule) && <Badge variant="outline">expired, ignored</Badge>}
                    </span>
                  )}
                </Td>
                <Td className="break-words">{rule.note}</Td>
                <Td>
                  <span className="flex flex-wrap gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!ready || pending !== undefined}
                      onClick={() => setPending({ kind: "edit", rule })}
                      aria-label={`Edit rule ${rule.id}`}
                    >
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!ready || pending !== undefined}
                      onClick={() => setPending({ kind: "delete", rule })}
                      aria-label={`Delete rule ${rule.id}`}
                    >
                      Delete
                    </Button>
                  </span>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {ready && pending?.kind === "add" && (
        <RuleForm owner={owner} rule={undefined} revision={revision} onClose={close} />
      )}
      {ready && pending?.kind === "edit" && (
        <RuleForm
          key={pending.rule.id}
          owner={owner}
          rule={pending.rule}
          revision={revision}
          onClose={close}
        />
      )}
      {ready && pending?.kind === "delete" && (
        <DeleteRulePanel rule={pending.rule} revision={revision} onClose={close} />
      )}
    </div>
  );
}
