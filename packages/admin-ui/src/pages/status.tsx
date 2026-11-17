import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/auth";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, Td, Th } from "@/components/ui/table";
import {
  configuredRuntimeText,
  getStatus,
  observedRuntimeText,
  requestProbe,
} from "@/lib/api/status";
import type { ShardStatus } from "@/lib/api/status";

function PolicyCell({ shard }: { shard: ShardStatus }) {
  return (
    <div className="flex flex-col gap-1">
      <Badge variant={shard.networkPolicy === "not-enforced" ? "destructive" : "secondary"}>
        {shard.networkPolicy}
      </Badge>
      {shard.networkPolicy === "unknown" && (
        <span className="text-xs text-muted-foreground">
          the isolation probe has not run since the last start
        </span>
      )}
      {shard.networkPolicyCheckedAt !== null && (
        <span className="text-xs text-muted-foreground">
          checked {shard.networkPolicyCheckedAt}
        </span>
      )}
      {shard.networkPolicyDetail !== null && (
        <span className="text-xs break-words">{shard.networkPolicyDetail.reason}</span>
      )}
    </div>
  );
}

/** Last reports of the orchestrator shards, as text. Nothing here is a heartbeat: rows persist through downtime. */
export function ShardStatusPage() {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: ["status"],
    queryFn: ({ signal }) => getStatus(token ?? "", signal),
    // A probe takes seconds to a minute; follow it until the state leaves `running`.
    refetchInterval: (query) =>
      query.state.data?.shards.some((shard) => shard.networkPolicy === "running") === true
        ? 3_000
        : false,
  });
  const probe = useMutation({
    mutationFn: () => requestProbe(token ?? ""),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["status"] }),
  });
  const shards = status.data?.shards ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Shard status</CardTitle>
        <CardDescription>
          The last report each orchestrator shard published. The publish time is the last start or
          attach write, not a heartbeat, and a row stays through downtime, so it may be stale. A
          configured runtime or an unknown or inconclusive policy does not prove isolation.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {status.isError && <Alert variant="destructive">{status.error.message}</Alert>}
        {status.isSuccess && shards.length === 0 && (
          <Alert>
            No reports yet. No shard has published its status, which is not the same as verified
            isolation.
          </Alert>
        )}
        {shards.length > 0 && (
          <Table>
            <thead>
              <tr>
                <Th>Shard</Th>
                <Th>Configured runtime</Th>
                <Th>Observed sandbox runtime</Th>
                <Th>Network policy</Th>
                <Th>Published</Th>
              </tr>
            </thead>
            <tbody>
              {shards.map((shard) => (
                <tr key={shard.shard} data-testid={`shard-${String(shard.shard)}`}>
                  <Td>{shard.shard}</Td>
                  <Td>{configuredRuntimeText(shard.configuredRuntime)}</Td>
                  <Td>{observedRuntimeText(shard.observedRuntime)}</Td>
                  <Td>
                    <PolicyCell shard={shard} />
                  </Td>
                  <Td>{shard.updatedAt}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => void status.refetch()}
            disabled={status.isFetching}
          >
            Refresh
          </Button>
          <Button size="sm" onClick={() => probe.mutate()} disabled={probe.isPending}>
            Run the isolation probe again
          </Button>
          <span className="text-xs text-muted-foreground">
            Asks shard 0 to re-measure the network policy, for example after a CNI or policy change.
            It takes seconds to about a minute.
          </span>
        </div>
        {probe.isError && <Alert variant="destructive">{probe.error.message}</Alert>}
        {probe.isSuccess && (
          <Alert>
            {probe.data.requested
              ? "Probe requested. This page follows the state until it leaves running."
              : `No new probe was queued: one is already ${probe.data.state}.`}
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
