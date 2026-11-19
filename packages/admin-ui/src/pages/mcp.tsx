import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { Link } from "react-router";
import { useAuth } from "@/auth";
import { DeleteConfirm } from "@/components/delete-confirm";
import { ProfileLinks } from "@/components/profile-ref-links";
import { ReadOnlyNote } from "@/components/read-only-note";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, Td, Th } from "@/components/ui/table";
import { Time } from "@/components/time";
import {
  deleteMcpServer,
  hostOf,
  knownSecretNames,
  listMcpServers,
  mcpHistory,
  nonDefaultLimits,
  putMcpServer,
} from "@/lib/api/mcp";
import type { McpServer } from "@/lib/api/mcp";
import { describeMcpChange } from "@/lib/mcp-history";
import { listProfileRefs, profilesWithMcp } from "@/lib/api/profile-refs";
import type { ProfileRef } from "@/lib/api/profile-refs";
import { useCatalogMode } from "@/lib/use-catalog-mode";
import { McpForm, ReadOnlyChoice } from "@/pages/mcp-form";
import type { Declared } from "@/pages/mcp-form";

type Pending =
  | { kind: "edit"; server: McpServer }
  | { kind: "delete"; server: McpServer }
  | { kind: "enable"; server: McpServer }
  | { kind: "create" };

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
  const loading = profiles === undefined && profilesError === undefined;
  const disable = useMutation({
    mutationFn: () => putMcpServer(token ?? "", server.name, { enabled: false }, server.revision),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["mcp"] });
      onClose();
    },
  });
  return (
    <DeleteConfirm
      kind="MCP server"
      name={server.name}
      contents="its settings (the history keeps them)"
      // A profile that names it keeps it from being deleted (ADR 0027): the API refuses, so the page does too.
      blocked={referencing.length > 0 || loading}
      note={
        <>
          {profilesError !== undefined && (
            <Alert variant="destructive">
              Could not load the profiles that may use it: {profilesError}
            </Alert>
          )}
          {loading && <p className="text-sm">Loading...</p>}
          {referencing.length > 0 && (
            <Alert variant="destructive">
              Used by <ProfileLinks profiles={referencing} />: publish a version of each without it
              first. To stop its tools now, disable it instead.
            </Alert>
          )}
          {disable.isError && <Alert variant="destructive">{disable.error.message}</Alert>}
        </>
      }
      actions={
        server.enabled && referencing.length > 0 ? (
          <Button size="sm" onClick={() => disable.mutate()} disabled={disable.isPending}>
            Disable instead
          </Button>
        ) : undefined
      }
      run={() => deleteMcpServer(token ?? "", server.name, server.revision)}
      onDeleted={() => {
        void queryClient.invalidateQueries({ queryKey: ["mcp"] });
        onClose();
      }}
      onCancel={onClose}
    />
  );
}

/** Enabling a server that is not declared read-only asks for the answer again. */
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
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <ReadOnlyChoice value={declared} onChange={setDeclared} />
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

const COLUMNS = 7;

function ServerRow({
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
  const [open, setOpen] = useState(false);
  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      putMcpServer(token ?? "", server.name, { enabled }, server.revision),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["mcp"] }),
  });
  const referencing = profiles === undefined ? undefined : profilesWithMcp(profiles, server.name);
  const limits = nonDefaultLimits(server);
  const hasDetails = limits.length > 0 || server.source !== null || server.onecliSecret !== null;
  return (
    <Fragment>
      <tr data-testid={`mcp-${server.name}`}>
        <Td className="font-medium break-all">{server.name}</Td>
        <Td>
          <Badge variant={server.enabled ? "secondary" : "warning"}>
            {server.enabled ? "enabled" : "disabled"}
          </Badge>
        </Td>
        <Td className="break-all">
          <span title={server.url}>{hostOf(server.url)}</span>
        </Td>
        <Td>
          {server.readOnly ? (
            <span className="text-muted-foreground">Read-only</span>
          ) : (
            <Badge variant="warning">Can change state</Badge>
          )}
        </Td>
        <Td>
          {referencing === undefined ? (
            ""
          ) : referencing.length === 0 ? (
            <span className="text-muted-foreground">{"\u2014"}</span>
          ) : (
            <ProfileLinks profiles={referencing} />
          )}
        </Td>
        <Td>
          <Time value={server.updatedAt} />
          <span className="text-muted-foreground"> by {server.updatedBy}</span>
        </Td>
        <Td>
          <span className="flex flex-wrap gap-1">
            <Link
              className={buttonVariants({ variant: "ghost", size: "sm" })}
              to={`/playground?mcp=${encodeURIComponent(server.name)}`}
            >
              Try in playground
            </Link>
            {hasDetails && (
              <Button
                size="sm"
                variant="ghost"
                aria-expanded={open}
                onClick={() => setOpen((shown) => !shown)}
              >
                Details
              </Button>
            )}
            {manage && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onAction({ kind: "edit", server })}
                >
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
              </>
            )}
          </span>
        </Td>
      </tr>
      {(open || toggle.isError) && (
        <tr>
          <Td colSpan={COLUMNS} className="bg-muted/40">
            {open && (
              <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1">
                {limits.map(({ label, value }) => (
                  <Fragment key={label}>
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd>{value}</dd>
                  </Fragment>
                ))}
                {server.onecliSecret !== null && (
                  <>
                    <dt className="text-muted-foreground">OneCLI secret</dt>
                    <dd className="break-all">
                      <code>{server.onecliSecret}</code>
                    </dd>
                  </>
                )}
                {server.source !== null && (
                  <>
                    <dt className="text-muted-foreground">Source</dt>
                    <dd className="break-all">
                      {server.source.repository} @ {server.source.commit}
                    </dd>
                  </>
                )}
              </dl>
            )}
            {toggle.isError && <Alert variant="destructive">{toggle.error.message}</Alert>}
          </Td>
        </tr>
      )}
    </Fragment>
  );
}

const HISTORY_SHOWN = 5;

function RecentChanges() {
  const { token } = useAuth();
  const [all, setAll] = useState(false);
  const history = useQuery({
    queryKey: ["mcp-history"],
    queryFn: ({ signal }) => mcpHistory(token ?? "", signal),
  });
  const entries = history.data ?? [];
  return (
    <details className="rounded-lg border bg-card px-6 py-4">
      <summary className="cursor-pointer font-semibold">Recent changes</summary>
      <div className="mt-3 flex flex-col gap-2">
        {history.isError && <Alert variant="destructive">{history.error.message}</Alert>}
        {history.isSuccess && entries.length === 0 && (
          <p className="text-sm text-muted-foreground">No changes yet.</p>
        )}
        <ul className="flex flex-col gap-1 text-sm">
          {(all ? entries : entries.slice(0, HISTORY_SHOWN)).map((entry) => (
            <li key={entry.id} className="break-words">
              <strong>{entry.name}</strong> {describeMcpChange(entry)}{" "}
              <span className="text-muted-foreground">
                <Time value={entry.changedAt} /> by {entry.changedBy}
              </span>
            </li>
          ))}
        </ul>
        {!all && entries.length > HISTORY_SHOWN && (
          <div>
            <Button size="sm" variant="ghost" onClick={() => setAll(true)}>
              Show more
            </Button>
          </div>
        )}
      </div>
    </details>
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
  const profiles = useQuery({
    queryKey: ["profile-refs"],
    queryFn: ({ signal }) => listProfileRefs(token ?? "", signal),
  });
  const queryClient = useQueryClient();
  const manage = mode === "manage";
  const close = (): void => {
    setPending(undefined);
    void servers.refetch();
    void queryClient.invalidateQueries({ queryKey: ["mcp-history"] });
    void profiles.refetch();
  };
  const secretNames = knownSecretNames(servers.data);
  const usedBy = (server: McpServer | undefined): boolean =>
    server !== undefined &&
    profiles.data !== undefined &&
    profilesWithMcp(profiles.data, server.name).length > 0;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>MCP servers</CardTitle>
          <CardDescription>
            Remote tool servers that sessions can call. Each enabled server's host gets a rule in
            the derived{" "}
            <Link className="underline" to="/egress/sets/mcp-catalog">
              mcp-catalog
            </Link>{" "}
            rule set, and the OneCLI host rules follow within seconds.
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
          {servers.isSuccess &&
            servers.data.servers.length === 0 &&
            servers.data.invalid.length === 0 && <p className="text-sm">No MCP servers yet.</p>}
          {profiles.isError && (
            <Alert variant="destructive">
              Could not load which profiles use them: {profiles.error.message}
            </Alert>
          )}
          {servers.data?.invalid.map((row) => (
            <Alert key={row.name} variant="destructive">
              <strong>{row.name}</strong>: this server&apos;s stored settings are invalid; edit it
              to fix them. {row.message}
            </Alert>
          ))}
          {servers.isSuccess && servers.data.servers.length > 0 && (
            <Table>
              <thead>
                <tr>
                  <Th>Name</Th>
                  <Th>Status</Th>
                  <Th>URL</Th>
                  <Th>Access</Th>
                  <Th>Used by</Th>
                  <Th>Updated</Th>
                  <Th>
                    <span className="sr-only">Actions</span>
                  </Th>
                </tr>
              </thead>
              <tbody>
                {servers.data.servers.map((server) => (
                  <ServerRow
                    key={server.name}
                    server={server}
                    profiles={profiles.data}
                    manage={manage}
                    onAction={setPending}
                  />
                ))}
              </tbody>
            </Table>
          )}
        </CardContent>
      </Card>

      {pending?.kind === "create" && (
        <McpForm
          server={undefined}
          usedByProfiles={false}
          secretNames={secretNames}
          onClose={close}
        />
      )}
      {pending?.kind === "edit" && (
        <McpForm
          key={pending.server.name}
          server={pending.server}
          usedByProfiles={usedBy(pending.server)}
          secretNames={secretNames}
          onClose={close}
        />
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

      <RecentChanges />
    </div>
  );
}
