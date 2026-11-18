import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/auth";
import { Time } from "@/components/time";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, Td, Th } from "@/components/ui/table";
import {
  getStatus,
  isStale,
  POLICY_TEXT,
  requestProbe,
  runtimeName,
  runtimeText,
  statusPollInterval,
  summarizeIsolation,
} from "@/lib/api/status";
import type { ShardStatus } from "@/lib/api/status";

function PolicyCell({ shard }: { shard: ShardStatus }) {
  return (
    <div className="flex flex-col gap-1">
      <Badge
        className="self-start"
        variant={shard.networkPolicy === "not-enforced" ? "destructive" : "secondary"}
      >
        {POLICY_TEXT[shard.networkPolicy]}
      </Badge>
      {shard.networkPolicyCheckedAt !== null && isStale(shard.networkPolicyCheckedAt) && (
        <span className="text-xs text-muted-foreground">
          checked <Time value={shard.networkPolicyCheckedAt} />
        </span>
      )}
      {shard.networkPolicyDetail !== null && (
        <span className="text-xs break-words">{shard.networkPolicyDetail.reason}</span>
      )}
    </div>
  );
}

function ShardTable({ shards }: { shards: readonly ShardStatus[] }) {
  const several = shards.length > 1;
  return (
    <Table>
      <thead>
        <tr>
          {several && <Th>Shard</Th>}
          <Th>Runtime</Th>
          <Th>Network isolation</Th>
          <Th>Last report</Th>
        </tr>
      </thead>
      <tbody>
        {shards.map((shard) => {
          const runtime = runtimeText(shard);
          return (
            <tr key={shard.shard} data-testid={`shard-${String(shard.shard)}`}>
              {several && <Td>{shard.shard}</Td>}
              <Td className={runtime.mismatch ? "font-medium text-destructive" : undefined}>
                {runtime.text}
              </Td>
              <Td>
                <PolicyCell shard={shard} />
              </Td>
              <Td>
                <Time value={shard.updatedAt} />
              </Td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}

function Spinner() {
  return (
    <span
      role="status"
      aria-label="Checking"
      className="inline-block size-4 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent"
    />
  );
}

/** Whether sandboxes are isolated, from the last report of each shard. A healthy answer is one line. */
export function ShardStatusPage() {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: ["status"],
    queryFn: ({ signal }) => getStatus(token ?? "", signal),
    refetchInterval: (query) => statusPollInterval(query.state.data?.shards),
  });
  const probe = useMutation({
    mutationFn: () => requestProbe(token ?? ""),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["status"] }),
  });
  const shards = status.data?.shards ?? [];
  const summary = summarizeIsolation(shards);
  const checking = summary.checking || probe.isPending;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Isolation</CardTitle>
        <CardDescription>
          Whether sandboxes are walled off from the node and the network.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {status.isError && <Alert variant="destructive">{status.error.message}</Alert>}
        {status.isSuccess && shards.length === 0 && (
          <p className="text-sm">No report yet {"—"} the runtime has not started.</p>
        )}
        {summary.problems.length > 0 && (
          <Alert variant="destructive">
            <ul className="flex flex-col gap-1">
              {summary.problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </Alert>
        )}
        {summary.notes.length > 0 && (
          <div
            className="flex flex-col gap-1 text-sm text-muted-foreground"
            data-testid="isolation-note"
          >
            {summary.healthy && summary.runtimes.length === 0 && (
              <p>Network isolation is enforced.</p>
            )}
            {summary.notes.map((note) => (
              <p key={note}>{note}</p>
            ))}
          </div>
        )}
        {summary.healthy && (
          <>
            {summary.runtimes.length > 0 && (
              <p
                className="rounded-lg border border-green-600/40 bg-green-500/10 px-4 py-3 text-sm text-green-800 dark:text-green-300"
                data-testid="isolation-ok"
              >
                Sandboxes run under {summary.runtimes.map(runtimeName).join(" and ")} and network
                isolation is enforced.
              </p>
            )}
            <details>
              <summary className="cursor-pointer text-sm font-medium">Details</summary>
              <div className="mt-2">
                <ShardTable shards={shards} />
              </div>
            </details>
          </>
        )}
        {!summary.healthy && shards.length > 0 && <ShardTable shards={shards} />}
        {shards.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              onClick={() => probe.mutate()}
              disabled={probe.isPending}
              title="Takes up to a minute."
            >
              Re-check network isolation
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void status.refetch()}
              disabled={status.isFetching}
            >
              Refresh
            </Button>
            {checking && <Spinner />}
          </div>
        )}
        {probe.isError && <Alert variant="destructive">{probe.error.message}</Alert>}
      </CardContent>
    </Card>
  );
}
