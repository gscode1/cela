import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { useAuth } from "@/auth";
import { DeleteConfirm } from "@/components/delete-confirm";
import { ProfileLinks } from "@/components/profile-ref-links";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, Td, Th } from "@/components/ui/table";
import { createRuleSet, deleteRuleSet, updateRuleSet } from "@/lib/api/egress";
import type { RuleSetSummary } from "@/lib/api/egress";
import type { StoredProfile } from "@/lib/api/profiles";
import { APPLIES_TO_ALL_WARNING, MAX_DESCRIPTION, ruleSetNameProblem } from "@/lib/egress-form";
import { keys, useProfilesQuery, useRuleSetsQuery } from "@/lib/queries";
import { EgressHistory } from "@/pages/egress/history";
import { useRevisionBase, WriteError } from "@/pages/egress/shared";

type Pending = { kind: "create" } | { kind: "edit" | "delete"; set: RuleSetSummary };

/** The profiles whose current version names the set. */
export const profilesUsing = (profiles: readonly StoredProfile[], set: string): StoredProfile[] =>
  profiles.filter((profile) => profile.definition.egressRuleSets?.includes(set) === true);

/** Create a rule set (`set` undefined) or change its description and whether it applies to every session. */
function RuleSetForm({
  set,
  revision,
  onClose,
}: {
  set: RuleSetSummary | undefined;
  revision: number;
  onClose: () => void;
}) {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  const editing = set !== undefined;
  const [name, setName] = useState("");
  const [description, setDescription] = useState(set?.description ?? "");
  const [appliesToAll, setAppliesToAll] = useState(set?.appliesToAll ?? false);
  const base = useRevisionBase(revision);
  const nameProblem = editing || name === "" ? undefined : ruleSetNameProblem(name);
  const problems: string[] = [];
  if (nameProblem !== undefined) problems.push(nameProblem);
  if (description.length > MAX_DESCRIPTION)
    problems.push(`The description has at most ${String(MAX_DESCRIPTION)} characters.`);
  const changes = {
    ...(set !== undefined && description !== set.description ? { description } : {}),
    ...(set !== undefined && appliesToAll !== set.appliesToAll ? { appliesToAll } : {}),
  };
  const nothingChanged = editing && Object.keys(changes).length === 0;
  // Turning it on is the step that widens who gets the rules; a new set that starts on is the same step.
  const widens = appliesToAll && (!editing || !set.appliesToAll);
  const save = useMutation({
    mutationFn: () =>
      set === undefined
        ? createRuleSet(token ?? "", { name, description, appliesToAll }, base.base)
        : updateRuleSet(token ?? "", set.name, changes, base.base),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: keys.egress });
      onClose();
    },
  });
  return (
    <Card aria-label={editing ? `Edit ${set.name}` : "Create a rule set"}>
      <CardHeader>
        <CardTitle>{editing ? `Edit ${set.name}` : "Create a rule set"}</CardTitle>
        <CardDescription>
          A rule set is a named group of rules. Profiles name the sets they use.
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
          {!editing && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="rule-set-name">Name</Label>
              <Input
                id="rule-set-name"
                autoComplete="off"
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                }}
              />
              <p className="text-xs text-muted-foreground">
                Fixed once saved: lowercase letters, digits and hyphens.
              </p>
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="rule-set-description">Description</Label>
            <Input
              id="rule-set-description"
              autoComplete="off"
              value={description}
              onChange={(event) => {
                setDescription(event.target.value);
              }}
            />
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id="rule-set-all"
              checked={appliesToAll}
              onChange={(event) => {
                setAppliesToAll(event.target.checked);
              }}
            />
            <Label htmlFor="rule-set-all">Applies to all sessions</Label>
          </div>
          {widens && (
            <Alert variant="warning" data-testid="applies-to-all-warning">
              {APPLIES_TO_ALL_WARNING}
              {editing &&
                ` It holds ${String(set.ruleCount)} ${set.ruleCount === 1 ? "rule" : "rules"} now.`}
            </Alert>
          )}
          {problems.length > 0 && (
            <ul className="list-disc pl-5 text-xs text-muted-foreground">
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          )}
          {save.isError && <WriteError error={save.error} revision={base} />}
          <div className="flex gap-2">
            <Button
              type="submit"
              disabled={
                problems.length > 0 || (!editing && name === "") || nothingChanged || save.isPending
              }
            >
              {editing ? "Save changes" : "Create rule set"}
            </Button>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            {nothingChanged && (
              <span className="self-center text-xs text-muted-foreground">No changes yet.</span>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function DeletePanel({
  set,
  revision,
  using,
  onClose,
}: {
  set: RuleSetSummary;
  revision: number;
  using: StoredProfile[];
  onClose: () => void;
}) {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  return (
    <DeleteConfirm
      kind="rule set"
      name={set.name}
      nameReusable
      contents={`its ${String(set.ruleCount)} ${set.ruleCount === 1 ? "rule" : "rules"} (the history keeps them)`}
      // A profile that names it keeps it from being deleted (ADR 0034): the API refuses, so the page does too.
      blocked={using.length > 0}
      note={
        <>
          {set.appliesToAll && (
            <Alert variant="warning">
              It applies to all sessions: they lose these rules when it is deleted.
            </Alert>
          )}
          {using.length > 0 && (
            <Alert variant="destructive" data-testid="delete-blocked-known">
              Used by <ProfileLinks profiles={using} />: publish a version of each without it first.
            </Alert>
          )}
        </>
      }
      run={() => deleteRuleSet(token ?? "", set.name, revision)}
      onDeleted={() => {
        void queryClient.invalidateQueries({ queryKey: keys.egress });
        onClose();
      }}
      onCancel={onClose}
    />
  );
}

export function RuleSetsPage() {
  const ruleSets = useRuleSetsQuery();
  const profiles = useProfilesQuery();
  const [pending, setPending] = useState<Pending | undefined>(undefined);
  const revision = ruleSets.data?.revision;
  const close = (): void => {
    setPending(undefined);
  };
  const using = (name: string): StoredProfile[] =>
    profiles.data === undefined ? [] : profilesUsing(profiles.data.profiles, name);
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Rule sets</CardTitle>
          <CardDescription>
            The hosts a sandbox may reach. A set applies to the sessions of the profiles that name
            it, or to every session when it applies to all.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {pending === undefined && (
            <div>
              <Button
                size="sm"
                disabled={revision === undefined}
                onClick={() => setPending({ kind: "create" })}
              >
                Create a rule set
              </Button>
            </div>
          )}
          {ruleSets.isError && <Alert variant="destructive">{ruleSets.error.message}</Alert>}
          {profiles.isError && (
            <Alert variant="destructive">
              Could not load which profiles use them: {profiles.error.message}
            </Alert>
          )}
          {ruleSets.data?.invalid.map((row) => (
            <Alert key={`${row.kind}-${row.ref}`} variant="destructive">
              <strong>
                {row.kind} {row.ref}
              </strong>
              : stored with invalid values and not evaluated. {row.message}
            </Alert>
          ))}
          {ruleSets.isSuccess && ruleSets.data.ruleSets.length === 0 && (
            <p className="text-sm">No rule sets yet: no session can reach anything.</p>
          )}
          {ruleSets.isSuccess && ruleSets.data.ruleSets.length > 0 && (
            <Table>
              <thead>
                <tr>
                  <Th>Name</Th>
                  <Th>Description</Th>
                  <Th>Rules</Th>
                  <Th>Used by</Th>
                  <Th>
                    <span className="sr-only">Actions</span>
                  </Th>
                </tr>
              </thead>
              <tbody>
                {ruleSets.data.ruleSets.map((set) => {
                  const named = using(set.name);
                  return (
                    <tr key={set.name} data-testid={`rule-set-${set.name}`}>
                      <Td className="font-medium break-all">
                        <Link
                          className="underline"
                          to={`/egress/sets/${encodeURIComponent(set.name)}`}
                        >
                          {set.name}
                        </Link>{" "}
                        {set.system === true ? (
                          <Badge variant="outline" title="Derived from the MCP catalog">
                            derived
                          </Badge>
                        ) : (
                          set.appliesToAll && (
                            <Badge variant="warning" title="Applies to all sessions">
                              all sessions
                            </Badge>
                          )
                        )}
                      </Td>
                      <Td className="break-words">{set.description}</Td>
                      <Td>{set.ruleCount}</Td>
                      <Td>
                        {profiles.data === undefined ? (
                          ""
                        ) : named.length === 0 ? (
                          <span className="text-muted-foreground">{"—"}</span>
                        ) : (
                          <ProfileLinks profiles={named} />
                        )}
                      </Td>
                      <Td>
                        {set.system === true ? (
                          <Link className="text-sm underline" to="/mcp-servers">
                            MCP servers
                          </Link>
                        ) : (
                          <span className="flex flex-wrap gap-1">
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={pending !== undefined}
                              onClick={() => setPending({ kind: "edit", set })}
                              aria-label={`Edit ${set.name}`}
                            >
                              Edit
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={pending !== undefined}
                              onClick={() => setPending({ kind: "delete", set })}
                              aria-label={`Delete ${set.name}`}
                            >
                              Delete
                            </Button>
                          </span>
                        )}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </CardContent>
      </Card>
      {revision !== undefined && pending?.kind === "create" && (
        <RuleSetForm set={undefined} revision={revision} onClose={close} />
      )}
      {revision !== undefined && pending?.kind === "edit" && (
        <RuleSetForm key={pending.set.name} set={pending.set} revision={revision} onClose={close} />
      )}
      {revision !== undefined && pending?.kind === "delete" && (
        <DeletePanel
          set={pending.set}
          revision={revision}
          using={using(pending.set.name)}
          onClose={close}
        />
      )}
      <EgressHistory />
    </div>
  );
}
