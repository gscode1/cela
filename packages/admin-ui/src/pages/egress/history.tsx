import { Time } from "@/components/time";
import { Alert } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { describeEgressChange } from "@/lib/egress-form";
import { useEgressHistoryQuery } from "@/lib/queries";

export function EgressHistory() {
  const history = useEgressHistoryQuery();
  return (
    <Card aria-label="History">
      <CardHeader>
        <CardTitle>History</CardTitle>
        <CardDescription>The latest changes to rule sets and rules, newest first.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {history.isError && <Alert variant="destructive">{history.error.message}</Alert>}
        {history.isSuccess && history.data.length === 0 && (
          <p className="text-sm text-muted-foreground">No changes yet.</p>
        )}
        <ul className="flex flex-col gap-1 text-sm">
          {(history.data ?? []).map((entry) => (
            <li key={entry.id} className="break-words" data-testid="egress-history-entry">
              <span className="text-muted-foreground">r{entry.revision}</span>{" "}
              {describeEgressChange(entry)}{" "}
              <span className="text-muted-foreground">
                <Time value={entry.changedAt} /> by {entry.changedBy}
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
