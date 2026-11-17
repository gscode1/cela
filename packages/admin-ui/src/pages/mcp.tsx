import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { useAuth } from "@/auth";
import { ReadOnlyNote } from "@/components/read-only-note";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiError } from "@/lib/api";
import { deleteMcpServer, listMcpServers, mcpHistory, putMcpServer } from "@/lib/api/mcp";
import type { McpFields, McpHistoryEntry, McpServer } from "@/lib/api/mcp";
import { listProfileRefs, profilesWithMcp } from "@/lib/api/profile-refs";
import type { ProfileRef } from "@/lib/api/profile-refs";
import { useCatalogMode } from "@/lib/use-catalog-mode";
import { McpForm, ReadOnlyChoice } from "@/pages/mcp-form";
import type { Declared } from "@/pages/mcp-form";

function ProfileLinks({ profiles }: { profiles: readonly ProfileRef[] }) {
  return (
    <span className="inline-flex flex-wrap gap-x-2">
      {profiles.map((profile) => (
        <Link
          key={profile.name}
          className="underline"
          to={`/profiles/${encodeURIComponent(profile.name)}`}
        >
          {profile.name}
          {profile.enabledForNew ? "" : " (disabled)"}
        </Link>
      ))}
    </span>
  );
}

type Pending =
  | { kind: "edit"; server: McpServer }
  | { kind: "delete"; server: McpServer }
  | { kind: "enable"; server: McpServer }
  | { kind: "create" };

function describeChange(entry: McpHistoryEntry): string {
  if (entry.action === "create") return "created";
  if (entry.action === "delete") return "deleted";
  const before = entry.old;
  const after = entry.new;
  if (before === null || after === null) return "updated";
  const fields: (keyof McpFields)[] = [
    "url",
    "enabled",
    "readOnly",
    "timeoutMs",
    "maxOutputBytes",
    "onecliSecret",
  ];
  const parts = fields
    .filter((field) => before[field] !== after[field])
    .map((field) => `${field}: ${String(before[field])} -> ${String(after[field])}`);
  return parts.length === 0 ? "updated (no field changed)" : parts.join("; ");
}

function DeletePanel({
  server,
  profiles,
  profilesError,
  onClose,
}: {
  server: McpServer;
  profiles: ProfileRef[] | undefined;
  profilesError: string | undefined;
  onClose: () => void;
}) {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  const referencing = profiles === undefined ? [] : profilesWithMcp(profiles, server.name);
  const remove = useMutation({
    mutationFn: () => deleteMcpServer(token ?? "", server.name, server.revision),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["mcp"] });
      onClose();
    },
  });
  const disable = useMutation({
    mutationFn: () => putMcpServer(token ?? "", server.name, { enabled: false }, server.revision),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["mcp"] });
      onClose();
    },
  });
  const conflict = remove.error instanceof ApiError && remove.error.status === 409;
  return (
    <Card aria-label={`Delete ${server.name}`}>
      <CardHeader>
        <CardTitle>Delete {server.name}?</CardTitle>
        <CardDescription>
          Deleting removes the row for real; the history keeps the old value. Disabling keeps the
          server in the catalog.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {profilesError !== undefined && (
          <Alert variant="destructive">
            Could not load the profiles that may reference it: {profilesError}
          </Alert>
        )}
        {profiles === undefined && profilesError === undefined && (
          <p className="text-sm">Loading profile references...</p>
        )}
        {referencing.length > 0 && (
          <Alert variant="destructive">
            Still referenced by <ProfileLinks profiles={referencing} />. A profile that names a
            deleted server cannot be changed until the reference is removed, and its tools stop
            working for existing sessions. Disable the server instead unless you mean to remove it.
          </Alert>
        )}
        {profiles !== undefined && referencing.length === 0 && (
          <p className="text-sm">No profile references this server.</p>
        )}
        {remove.isError && (
          <Alert variant="destructive">
            {remove.error.message}
            {conflict &&
              " The server changed since this page loaded; close this and reload the list."}
          </Alert>
        )}
        {disable.isError && <Alert variant="destructive">{disable.error.message}</Alert>}
        <div className="flex flex-wrap gap-2">
          {server.enabled && (
            <Button size="sm" onClick={() => disable.mutate()} disabled={disable.isPending}>
              Disable instead
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => remove.mutate()}
            disabled={remove.isPending || (profiles === undefined && profilesError === undefined)}
          >
            Delete {server.name}
          </Button>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/** Enabling a server that is not declared read-only asks for the declaration again. */
function EnablePanel({ server, onClose }: { server: McpServer; onClose: () => void }) {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  const [declared, setDeclared] = useState<Declared>("");
  const enable = useMutation({
    mutationFn: () =>
      putMcpServer(
        token ?? "",
        server.name,
        { enabled: true, readOnly: declared === "yes" },
        server.revision,
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["mcp"] });
      onClose();
    },
  });
  return (
    <Card aria-label={`Enable ${server.name}`}>
      <CardHeader>
        <CardTitle>Enable {server.name}</CardTitle>
        <CardDescription>
          It is not declared read-only. Confirm what it is before sessions can call it.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <ReadOnlyChoice value={declared} onChange={setDeclared} prompt="Read-only declaration" />
        {enable.isError && <Alert variant="destructive">{enable.error.message}</Alert>}
        <div className="flex gap-2">
          <Button
            size="sm"
            onClick={() => enable.mutate()}
            disabled={declared === "" || enable.isPending}
          >
            Enable
          </Button>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function ServerCard({
  server,
  profiles,
  manage,
  onAction,
}: {
  server: McpServer;
  profiles: ProfileRef[] | undefined;
  manage: boolean;
  onAction: (pending: Pending) => void;
}) {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      putMcpServer(token ?? "", server.name, { enabled }, server.revision),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["mcp"] }),
  });
  const referencing = profiles === undefined ? undefined : profilesWithMcp(profiles, server.name);
  const rows: [string, ReactNode][] = [
    ["URL", <span className="break-all">{server.url}</span>],
    ["Transport", "streamable-http"],
    ["timeoutMs", String(server.timeoutMs)],
    ["maxOutputBytes", String(server.maxOutputBytes)],
    ["onecliSecret", `${server.onecliSecret ?? "none"} (read-only until #42)`],
    ["Reachability", `${server.reachability} (the API does not probe the network)`],
    ["Revision", String(server.revision)],
    ["Updated", `${server.updatedAt} by ${server.updatedBy}`],
    ...(server.source === null
      ? []
      : ([["Source", `${server.source.repository} @ ${server.source.commit}`]] as [
          string,
          string,
        ][])),
    [
      "Profiles",
      referencing === undefined ? (
        "loading"
      ) : referencing.length === 0 ? (
        "none"
      ) : (
        <ProfileLinks profiles={referencing} />
      ),
    ],
  ];
  return (
    <Card data-testid={`mcp-${server.name}`}>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle>{server.name}</CardTitle>
          <Badge variant={server.enabled ? "secondary" : "warning"}>
            {server.enabled ? "enabled" : "disabled"}
          </Badge>
          <Badge variant="outline">readOnly: {String(server.readOnly)}</Badge>
        </div>
        {!server.enabled && (
          <CardDescription>
            Disabled: the server stays in the catalog and its tools are unavailable to sessions.
          </CardDescription>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="min-w-0">{value}</dd>
            </div>
          ))}
        </dl>
        {toggle.isError && <Alert variant="destructive">{toggle.error.message}</Alert>}
        {manage && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => onAction({ kind: "edit", server })}>
              Edit
            </Button>
            {server.enabled ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => toggle.mutate(false)}
                disabled={toggle.isPending}
              >
                Disable
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={toggle.isPending}
                onClick={() =>
                  server.readOnly ? toggle.mutate(true) : onAction({ kind: "enable", server })
                }
              >
                Enable
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={() => onAction({ kind: "delete", server })}
            >
              Delete
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function McpServersPage() {
  const { token } = useAuth();
  const { mode, error: modeError } = useCatalogMode();
  const [pending, setPending] = useState<Pending | undefined>(undefined);
  const servers = useQuery({
    queryKey: ["mcp"],
    queryFn: ({ signal }) => listMcpServers(token ?? "", signal),
  });
  const history = useQuery({
    queryKey: ["mcp-history"],
    queryFn: ({ signal }) => mcpHistory(token ?? "", signal),
  });
  const profiles = useQuery({
    queryKey: ["profile-refs"],
    queryFn: ({ signal }) => listProfileRefs(token ?? "", signal),
  });
  const manage = mode === "manage";
  const close = (): void => {
    setPending(undefined);
    void servers.refetch();
    void history.refetch();
    void profiles.refetch();
  };

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>MCP servers</CardTitle>
          <CardDescription>
            Remote servers sessions can call (Streamable HTTP over https). Reachability is always
            unknown: the API does not probe the network, and a host without an OneCLI rule fails
            only when the orchestrator connects.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {modeError !== undefined && <Alert variant="destructive">{modeError}</Alert>}
          {mode === "readOnly" && <ReadOnlyNote what="MCP servers" />}
          {manage && pending === undefined && (
            <div>
              <Button size="sm" onClick={() => setPending({ kind: "create" })}>
                Register a server
              </Button>
            </div>
          )}
          {servers.isError && <Alert variant="destructive">{servers.error.message}</Alert>}
          {servers.isSuccess && servers.data.servers.length === 0 && (
            <p className="text-sm">No MCP servers registered.</p>
          )}
          {profiles.isError && (
            <Alert variant="destructive">
              Could not load profile references: {profiles.error.message}
            </Alert>
          )}
        </CardContent>
      </Card>

      {pending?.kind === "create" && <McpForm server={undefined} onClose={close} />}
      {pending?.kind === "edit" && (
        <McpForm key={pending.server.name} server={pending.server} onClose={close} />
      )}
      {pending?.kind === "delete" && (
        <DeletePanel
          server={pending.server}
          profiles={profiles.data}
          profilesError={profiles.isError ? profiles.error.message : undefined}
          onClose={close}
        />
      )}
      {pending?.kind === "enable" && <EnablePanel server={pending.server} onClose={close} />}

      {servers.data?.invalid.map((row) => (
        <Alert key={row.name} variant="destructive">
          Invalid stored row <strong>{row.name}</strong>: {row.message}. The orchestrator skips it.
        </Alert>
      ))}
      {servers.data?.servers.map((server) => (
        <ServerCard
          key={server.name}
          server={server}
          profiles={profiles.data}
          manage={manage}
          onAction={setPending}
        />
      ))}

      <Card>
        <CardHeader>
          <CardTitle>Recent changes</CardTitle>
          <CardDescription>The newest 20 entries of the MCP history.</CardDescription>
        </CardHeader>
        <CardContent>
          {history.isError && <Alert variant="destructive">{history.error.message}</Alert>}
          {history.isSuccess && history.data.length === 0 && (
            <p className="text-sm">No changes recorded.</p>
          )}
          <ul className="flex flex-col gap-1 text-sm">
            {history.data?.map((entry) => (
              <li key={entry.id} className="break-words">
                <span className="text-muted-foreground">{entry.changedAt}</span>{" "}
                <strong>{entry.name}</strong> {describeChange(entry)}{" "}
                <span className="text-muted-foreground">by {entry.changedBy}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
