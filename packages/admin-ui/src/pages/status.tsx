import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { useAuth } from "@/auth";
import { Time } from "@/components/time";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, Td, Th } from "@/components/ui/table";
import { requestProbe, runtimeText } from "@/lib/api/status";
import { keys } from "@/lib/queries";
import { configuredProviders, mcpState, networkPolicyOf } from "@/lib/status-rows";
import type { Level, StatusInputs, StatusRow } from "@/lib/status-rows";
import { useStatusRows } from "@/lib/use-status-rows";
import { cn } from "@/lib/utils";

const DOT: Record<Level, { color: string; label: string }> = {
  problem: { color: "bg-red-600", label: "Problem" },
  attention: { color: "bg-amber-500", label: "Needs attention" },
  unknown: { color: "bg-muted-foreground/50", label: "Unknown" },
  ok: { color: "bg-green-600", label: "OK" },
  info: { color: "bg-muted-foreground/50", label: "Fact" },
};

/** The state dot of a row; the word is there for screen readers and for a hover. */
function StateDot({ level }: { level: Level }) {
  const { color, label } = DOT[level];
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-level={level}
      className={cn("inline-block size-2.5 shrink-0 rounded-full", color)}
    />
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

function Facts({ children }: { children: ReactNode }) {
  return <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">{children}</dl>;
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}

const yesNo = (value: boolean): string => (value ? "yes" : "no");

function RuntimeDetails({ inputs }: { inputs: StatusInputs }) {
  if (inputs.status.state !== "ok") return null;
  const shards = inputs.status.data.shards;
  const several = shards.length > 1;
  return (
    <Table>
      <thead>
        <tr>
          {several && <Th>Shard</Th>}
          <Th>Runtime</Th>
        </tr>
      </thead>
      <tbody>
        {shards.map((shard) => {
          const runtime = runtimeText(shard);
          return (
            <tr key={shard.shard} data-testid={`runtime-${String(shard.shard)}`}>
              {several && <Td>{shard.shard}</Td>}
              <Td className={runtime.mismatch ? "font-medium text-destructive" : undefined}>
                {runtime.text}
              </Td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}

function NetworkDetails({ inputs }: { inputs: StatusInputs }) {
  if (inputs.status.state !== "ok") return null;
  const policy = networkPolicyOf(inputs.status.data);
  return (
    <Facts>
      <Fact label="Scope">The whole cluster: one check, run by the first shard.</Fact>
      <Fact label="Result">{policy.reason ?? "No result yet."}</Fact>
      <Fact label="Checked">
        {policy.checkedAt === null ? "not since the last start" : <Time value={policy.checkedAt} />}
      </Fact>
    </Facts>
  );
}

function ShardsDetails({ inputs }: { inputs: StatusInputs }) {
  if (inputs.status.state !== "ok") return null;
  return (
    <Table>
      <thead>
        <tr>
          <Th>Shard</Th>
          <Th>Last report</Th>
        </tr>
      </thead>
      <tbody>
        {inputs.status.data.shards.map((shard) => (
          <tr key={shard.shard} data-testid={`shard-${String(shard.shard)}`}>
            <Td>{shard.shard}</Td>
            <Td>
              <Time value={shard.updatedAt} />
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function EgressDetails({ inputs }: { inputs: StatusInputs }) {
  if (inputs.egress.state !== "ok") return null;
  const { revision, ruleSets, rules, invalid, principals, proxy } = inputs.egress.data;
  return (
    <div className="flex flex-col gap-3">
      <Facts>
        <Fact label="Rules revision">{revision}</Fact>
        <Fact label="Stored">
          {ruleSets} {ruleSets === 1 ? "rule set" : "rule sets"}, {rules}{" "}
          {rules === 1 ? "rule" : "rules"}
        </Fact>
        <Fact label="Invalid rows">{invalid}</Fact>
        {principals !== undefined && (
          <Fact label="Session tokens">
            {principals.active} active, {principals.withPodIp} with a Pod address,{" "}
            {principals.revoked} revoked
          </Fact>
        )}
      </Facts>
      {proxy.replicas.length > 0 && (
        <Table>
          <thead>
            <tr>
              <Th>Replica</Th>
              <Th>State</Th>
              <Th>Revision</Th>
            </tr>
          </thead>
          <tbody>
            {proxy.replicas.map((replica, index) => (
              <tr key={replica.name ?? index}>
                <Td>{replica.name ?? "proxy"}</Td>
                <Td>{replica.state ?? "serving"}</Td>
                <Td>{replica.revision ?? "?"}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}

function OnecliDetails({ inputs }: { inputs: StatusInputs }) {
  const models = inputs.models.state === "ok" ? inputs.models.data : undefined;
  const secrets = inputs.mcp.state === "ok" ? inputs.mcp.data.onecliSecrets : undefined;
  return (
    <Facts>
      {models !== undefined && (
        <Fact label="Model credentials">
          {models.reason ??
            (models.providers.length === 0
              ? configuredProviders(models).join(", ") || "none"
              : models.providers.map((p) => `${p.provider}: ${p.credential}`).join(", "))}
        </Fact>
      )}
      <Fact label="Secret names">
        {secrets?.source === "orchestrator"
          ? secrets.names.length === 0
            ? "none"
            : secrets.names.join(", ")
          : "unknown (no OneCLI admin key, or the orchestrator has not published them)"}
      </Fact>
      <Fact label="Health">OneCLI reports no gateway health, so there is no up or down here.</Fact>
    </Facts>
  );
}

function McpDetails({ inputs }: { inputs: StatusInputs }) {
  if (inputs.mcp.state !== "ok") return null;
  const { servers, invalid } = inputs.mcp.data;
  return (
    <div className="flex flex-col gap-2">
      {servers.length > 0 && (
        <Table>
          <thead>
            <tr>
              <Th>Server</Th>
              <Th>State</Th>
              <Th>Tools</Th>
              <Th>Checked</Th>
            </tr>
          </thead>
          <tbody>
            {servers.map((server) => (
              <tr key={server.name} data-testid={`status-mcp-${server.name}`}>
                <Td>{server.name}</Td>
                <Td>
                  {mcpState(server)}
                  {server.discovery?.error !== undefined && (
                    <span className="block text-xs break-words text-destructive">
                      {server.discovery.error}
                    </span>
                  )}
                </Td>
                <Td>{server.discovery?.tools ?? 0}</Td>
                <Td>
                  {server.discovery?.checkedAt == null ? (
                    "—"
                  ) : (
                    <Time value={server.discovery.checkedAt} />
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {invalid.map((row) => (
        <p key={row.name} className="text-sm text-destructive">
          {row.name}: the stored row is invalid and skipped ({row.message})
        </p>
      ))}
    </div>
  );
}

function DeploymentDetails({ inputs }: { inputs: StatusInputs }) {
  const d = inputs.deployment;
  if (d === undefined) return null;
  const sizes = d.sizes.state === "ok" ? d.sizes.data : undefined;
  return (
    <Facts>
      {d.networkModes.state === "ok" && (
        <Fact label="Direct egress allowed">
          {yesNo(d.networkModes.data.directAllowed)}{" "}
          <span className="text-muted-foreground">(security.allowDirectSandboxEgress)</span>
        </Fact>
      )}
      {d.flavours.state === "ok" && (
        <Fact label="Browser image">
          {d.flavours.data.browserEnabled ? "enabled" : "disabled"}{" "}
          <span className="text-muted-foreground">(sandbox.flavours.browser.enabled)</span>
        </Fact>
      )}
      {sizes !== undefined && (
        <Fact label="Sandbox sizes">
          {sizes.sizes.length === 0
            ? "none defined"
            : sizes.sizes
                .map((size) =>
                  size.name === sizes.defaultSize ? `${size.name} (default)` : size.name,
                )
                .join(", ")}
        </Fact>
      )}
      {inputs.models.state === "ok" && (
        <Fact label="Model catalog">
          {inputs.models.data.source === "orchestrator"
            ? "published by the orchestrator"
            : "not published yet"}
        </Fact>
      )}
      {d.tools.state === "ok" && (
        <Fact label="Tools">
          {d.tools.data.source === "orchestrator"
            ? "published by the orchestrator"
            : "built-in names, before an orchestrator has started"}
        </Fact>
      )}
    </Facts>
  );
}

function Details({ row, inputs }: { row: StatusRow; inputs: StatusInputs }) {
  switch (row.id) {
    case "runtime":
      return <RuntimeDetails inputs={inputs} />;
    case "network":
      return <NetworkDetails inputs={inputs} />;
    case "direct":
      return (
        <p className="text-sm">
          These sessions bypass the egress proxy: no rules apply and nothing is audited (network
          mode <code>direct</code>).
        </p>
      );
    case "shards":
      return <ShardsDetails inputs={inputs} />;
    case "egress":
      return <EgressDetails inputs={inputs} />;
    case "onecli":
      return <OnecliDetails inputs={inputs} />;
    case "mcp":
      return <McpDetails inputs={inputs} />;
    case "deployment":
      return <DeploymentDetails inputs={inputs} />;
  }
}

function StatusLineRow({
  row,
  inputs,
  action,
}: {
  row: StatusRow;
  inputs: StatusInputs;
  action?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const detailsId = `status-details-${row.id}`;
  const expandable = row.unavailable !== true;
  return (
    <li className="flex flex-col gap-2 py-3" data-testid={`status-row-${row.id}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <StateDot level={row.level} />
        <span className="min-w-0 flex-1 text-sm font-medium sm:w-44 sm:flex-none">{row.title}</span>
        <span className="order-last w-full min-w-0 pl-5 text-sm break-words sm:order-none sm:w-auto sm:flex-1 sm:pl-0">
          {row.sentence}
          {row.failing !== undefined && (
            <>
              {" "}
              Failing:{" "}
              {row.failing.map((name, index) => (
                <span key={name}>
                  {index > 0 && ", "}
                  <Link to="/mcp-servers" className="underline underline-offset-2">
                    {name}
                  </Link>
                </span>
              ))}
              .
            </>
          )}
          {row.when !== undefined && (
            <span className="text-muted-foreground">
              {" "}
              {row.when.label} <Time value={row.when.iso} />
            </span>
          )}
        </span>
        <span className="flex items-center gap-2">
          {row.checking === true && <Spinner />}
          {action}
          {expandable && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-expanded={open}
              aria-controls={detailsId}
              aria-label={`Details of ${row.title}`}
              onClick={() => setOpen(!open)}
            >
              Details
            </Button>
          )}
        </span>
      </div>
      {open && expandable && (
        <div id={detailsId} className="ml-5 overflow-x-auto">
          <Details row={row} inputs={inputs} />
        </div>
      )}
    </li>
  );
}

/** Whether sandboxes are isolated and the parts around them are healthy: one line per area, problems first. */
export function ShardStatusPage() {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  const { rows, inputs, refresh, fetching } = useStatusRows();
  const probe = useMutation({
    mutationFn: () => requestProbe(token ?? ""),
    onSettled: () => queryClient.invalidateQueries({ queryKey: keys.status }),
  });
  // The first shard takes the request: before it has reported there is nobody to ask (503).
  const reported = inputs.status.state === "ok" && inputs.status.data.shards.length > 0;
  const recheck = (
    <Button
      size="sm"
      variant="outline"
      onClick={() => probe.mutate()}
      disabled={probe.isPending}
      title="Takes up to a minute."
    >
      Re-check
    </Button>
  );

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <CardTitle>Status</CardTitle>
          <CardDescription>
            What the orchestrators last reported, and the parts around them.
          </CardDescription>
        </div>
        <Button size="sm" variant="outline" onClick={refresh} disabled={fetching}>
          Refresh
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {probe.isError && <Alert variant="destructive">{probe.error.message}</Alert>}
        <ul className="flex flex-col divide-y">
          {rows.map((row) => (
            <StatusLineRow
              key={row.id}
              row={row}
              inputs={inputs}
              action={row.id === "network" && reported ? recheck : undefined}
            />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
