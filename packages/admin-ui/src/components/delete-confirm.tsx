import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError } from "@/lib/api";
import type { BlockedBy } from "@/lib/api";

/** Why the API refused a delete, as sentences with the fix (docs/decisions/0027-admin-delete.md). */
export function BlockedReasons({ blockedBy }: { blockedBy: BlockedBy }) {
  return (
    <ul className="list-disc pl-5 text-sm" data-testid="blocked-by">
      {blockedBy.defaultProfile === true && (
        <li>
          It is the default profile for new sessions: choose another in{" "}
          <Link className="underline" to="/settings">
            Global settings
          </Link>{" "}
          first.
        </li>
      )}
      {blockedBy.enabledForNew === true && (
        <li>It is still open to new sessions: disable it first.</li>
      )}
      {blockedBy.profiles !== undefined && blockedBy.profiles.length > 0 && (
        <li>
          Used by{" "}
          {blockedBy.profiles.map((profile, index) => (
            <span key={profile.name}>
              {index > 0 && ", "}
              <Link className="underline" to={`/profiles/${encodeURIComponent(profile.name)}`}>
                {profile.name}
              </Link>
            </span>
          ))}
          : publish a version of each without it first.
        </li>
      )}
      {blockedBy.sessions !== undefined && blockedBy.sessions.count > 0 && (
        <li>
          {blockedBy.sessions.count} {blockedBy.sessions.count === 1 ? "session" : "sessions"} that
          are not deleted still use it (for example{" "}
          <span className="font-mono break-all">{blockedBy.sessions.sample.join(", ")}</span>). It
          can be deleted once they are.
        </li>
      )}
    </ul>
  );
}

/**
 * A delete that cannot be undone: the operator types the name, and a refusal shows the API's reasons. `blocked` is
 * what the page already knows keeps the delete from happening (then the button stays off and `note` says why); the
 * API checks again either way.
 */
export function DeleteConfirm({
  kind,
  name,
  contents,
  nameReusable = false,
  blocked = false,
  note,
  actions,
  run,
  onDeleted,
  onCancel,
}: {
  /** "profile", "skill", "MCP server". */
  kind: string;
  name: string;
  /** What goes with it, for the warning: "all its versions". */
  contents: string;
  /** The name may be used again after the delete (a rule set); the default says it never can. */
  nameReusable?: boolean;
  blocked?: boolean;
  note?: ReactNode;
  /** Other ways out, such as "Disable instead". */
  actions?: ReactNode;
  run: () => Promise<unknown>;
  onDeleted: () => void;
  onCancel: () => void;
}) {
  const [typed, setTyped] = useState("");
  const remove = useMutation({ mutationFn: run, onSuccess: onDeleted });
  const error = remove.error instanceof ApiError ? remove.error : undefined;
  const id = `delete-${kind.replace(/\W+/g, "-")}-confirm`;
  return (
    <Card aria-label={`Delete ${name}`}>
      <CardHeader>
        <CardTitle>Delete {name}?</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm">
          This removes the {kind} {name} and {contents} for good. It cannot be undone
          {nameReusable ? "." : `, and the name ${name} can never be used again.`}
        </p>
        {note}
        {error?.blockedBy !== undefined && (
          <Alert variant="destructive" data-testid="delete-refused">
            <p>Not deleted:</p>
            <BlockedReasons blockedBy={error.blockedBy} />
          </Alert>
        )}
        {error !== undefined && error.blockedBy === undefined && error.status === 409 && (
          <Alert variant="destructive" data-testid="delete-refused">
            Not deleted: it changed since this page loaded. Close this and reload.
          </Alert>
        )}
        {remove.isError && (error === undefined || error.status !== 409) && (
          <Alert variant="destructive">{remove.error.message}</Alert>
        )}
        {!blocked && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={id}>Type {name} to confirm</Label>
            <Input
              id={id}
              autoComplete="off"
              value={typed}
              onChange={(event) => {
                setTyped(event.target.value);
              }}
            />
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          {actions}
          <Button
            size="sm"
            variant="outline"
            disabled={blocked || typed !== name || remove.isPending}
            onClick={() => {
              remove.mutate();
            }}
          >
            Delete {name}
          </Button>
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
