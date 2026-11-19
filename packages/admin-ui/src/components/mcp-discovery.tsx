import { Badge } from "@/components/ui/badge";
import { Time } from "@/components/time";
import type { McpServer } from "@/lib/api/mcp";

/** "1 tool", "3 tools". */
const toolsText = (count: number): string => `${String(count)} ${count === 1 ? "tool" : "tools"}`;

/**
 * The one Status badge of a server: disabled, ready with the tool count, failing, or unknown. The failure text and
 * the check time are in the row's Details (see DiscoveryDetail).
 */
export function ServerStatus({ server }: { server: McpServer }) {
  const discovery = server.discovery;
  if (!server.enabled || discovery?.state === "disabled") {
    return <Badge variant="warning">disabled</Badge>;
  }
  if (discovery === undefined || discovery.state === "unknown" || discovery.checkedAt === null) {
    return (
      <span title="No orchestrator has reported on this server since it started">
        <Badge variant="outline">unknown</Badge>
      </span>
    );
  }
  return discovery.state === "ready" ? (
    <Badge variant="secondary">
      ready {"\u00b7"} {toolsText(discovery.tools)}
    </Badge>
  ) : (
    <Badge variant="destructive">failing</Badge>
  );
}

/** What the last discovery found, for the Details view: the error of a failing server and when it was checked. */
export function DiscoveryDetail({ server }: { server: McpServer }) {
  const discovery = server.discovery;
  if (!server.enabled || discovery === undefined || discovery.checkedAt === null) return null;
  return (
    <>
      {discovery.state === "failed" && discovery.error !== undefined && (
        <>
          <dt className="text-muted-foreground">Error</dt>
          <dd className="break-words text-destructive">{discovery.error}</dd>
        </>
      )}
      <dt className="text-muted-foreground">Checked</dt>
      <dd>
        <Time value={discovery.checkedAt} />
      </dd>
    </>
  );
}

/** The tool names of the last discovery, for the Details view; empty while there are none to show. */
export function DiscoveryTools({ server }: { server: McpServer }) {
  const names = server.discovery?.toolNames ?? [];
  if (names.length === 0) return null;
  const hidden = (server.discovery?.tools ?? 0) - names.length;
  return (
    <>
      <dt className="text-muted-foreground">Tools</dt>
      <dd className="break-words">
        {names.map((name, index) => (
          <span key={name}>
            {index > 0 && ", "}
            <code>{name}</code>
          </span>
        ))}
        {hidden > 0 && <span className="text-muted-foreground"> and {String(hidden)} more</span>}
      </dd>
    </>
  );
}
