import { Badge } from "@/components/ui/badge";
import { Time } from "@/components/time";
import type { McpServer } from "@/lib/api/mcp";

/** "1 tool", "3 tools". */
const toolsText = (count: number): string => `${String(count)} ${count === 1 ? "tool" : "tools"}`;

/**
 * What the orchestrator found when it last connected to the server through the gateway: ok with the tool count,
 * failing with the error text, or unknown. A disabled server is not discovered, so the Status column already says it.
 */
export function DiscoveryStatus({ server }: { server: McpServer }) {
  const discovery = server.discovery;
  if (!server.enabled || discovery === undefined || discovery.state === "disabled") {
    return <span className="text-muted-foreground">{"—"}</span>;
  }
  if (discovery.state === "unknown" || discovery.checkedAt === null) {
    return (
      <span title="No orchestrator has reported on this server since it started">
        <Badge variant="outline">unknown</Badge>
      </span>
    );
  }
  return (
    <span className="flex flex-col gap-1">
      {discovery.state === "ready" ? (
        <Badge variant="secondary">ok, {toolsText(discovery.tools)}</Badge>
      ) : (
        <Badge variant="destructive">failing</Badge>
      )}
      {discovery.state === "failed" && discovery.error !== undefined && (
        <span className="text-xs break-words text-destructive">{discovery.error}</span>
      )}
      <span className="text-xs text-muted-foreground">
        checked <Time value={discovery.checkedAt} />
      </span>
    </span>
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
