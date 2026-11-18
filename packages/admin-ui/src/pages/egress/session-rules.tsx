import { useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SESSION_ID } from "@/lib/api/egress";
import { useSessionRulesQuery } from "@/lib/queries";
import { UnfilteredBadge } from "@/pages/profiles/pickers";
import { RuleManager } from "@/pages/egress/rule-manager";

function SessionRules({ sessionId }: { sessionId: string }) {
  const rules = useSessionRulesQuery(sessionId);
  return (
    <div className="flex flex-col gap-3">
      {rules.data?.networkMode === "direct" && (
        <Alert role="status" data-testid="session-direct">
          <UnfilteredBadge /> This session is in network mode direct: its sandbox does not use the
          egress proxy, so no rule applies to it and nothing is audited.
        </Alert>
      )}
      {rules.isError && <Alert variant="destructive">{rules.error.message}</Alert>}
      {rules.isSuccess && (
        <RuleManager
          owner={{ sessionId }}
          rules={rules.data.rules}
          revision={rules.data.revision}
        />
      )}
    </div>
  );
}

/** A session's own rules: temporary, for that session only. For admin use; the orchestrator writes them later. */
export function SessionRulesPanel() {
  const [typed, setTyped] = useState("");
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  const id = typed.trim();
  const valid = SESSION_ID.test(id);
  return (
    <Card aria-label="Session rules">
      <CardHeader>
        <CardTitle>Session rules</CardTitle>
        <CardDescription>
          Rules of one session, on top of its profile&apos;s sets. On the same host a session rule
          beats a rule set&apos;s. The session need not exist; a rule for a deleted session does
          nothing.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <form
          className="flex max-w-xl items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setSessionId(id);
          }}
        >
          <div className="flex flex-1 flex-col gap-1.5">
            <Label htmlFor="session-rules-id">Session id</Label>
            <Input
              id="session-rules-id"
              autoComplete="off"
              value={typed}
              onChange={(event) => {
                setTyped(event.target.value);
                setSessionId(undefined);
              }}
            />
          </div>
          <Button type="submit" disabled={!valid}>
            Show rules
          </Button>
        </form>
        {typed !== "" && !valid && (
          <p className="text-xs text-muted-foreground">A session id is a lowercase UUID.</p>
        )}
        {sessionId !== undefined && <SessionRules key={sessionId} sessionId={sessionId} />}
      </CardContent>
    </Card>
  );
}
