import { Time } from "@/components/time";
import { Alert } from "@/components/ui/alert";
import { describeEgressChange } from "@/lib/egress-form";
import { useEgressHistoryQuery } from "@/lib/queries";

/** The latest changes to rule sets and rules, newest first, collapsed under the rule sets. */
export function EgressHistory() {
  const history = useEgressHistoryQuery();
  return (
    <details className="rounded-lg border bg-card px-6 py-4" aria-label="Recent changes">
      <summary className="cursor-pointer font-semibold">Recent changes</summary>
      <div className="mt-3 flex flex-col gap-2">
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
      </div>
    </details>
  );
}
