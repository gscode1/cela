import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { useAuth } from "@/auth";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError } from "@/lib/api";
import {
  listMcpServers,
  MCP_LIMITS,
  MCP_NAME,
  numberProblem,
  putMcpServer,
  urlProblem,
} from "@/lib/api/mcp";
import type { McpFields, McpServer } from "@/lib/api/mcp";

export type Declared = "yes" | "no" | "";

/** The declaration the operator makes: one client serves every session, so the server must be stateless. */
export function ReadOnlyChoice({
  value,
  onChange,
  prompt,
}: {
  value: Declared;
  onChange: (value: Declared) => void;
  prompt: string;
}) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-sm font-medium">{prompt}</legend>
      <p className="text-xs text-muted-foreground">
        One MCP client serves every session, so declare whether the server is stateless and changes
        nothing.
      </p>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="radio"
          name="readOnly"
          checked={value === "yes"}
          onChange={() => onChange("yes")}
        />
        Read-only: stateless, it changes nothing
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="radio"
          name="readOnly"
          checked={value === "no"}
          onChange={() => onChange("no")}
        />
        Not read-only: it can change state
      </label>
    </fieldset>
  );
}

const sameUrl = (a: string, b: string): boolean => {
  try {
    return new URL(a).toString() === new URL(b).toString();
  } catch {
    return a === b;
  }
};

/**
 * Register a server (`server` undefined) or edit one. The draft lives in this component, so a `409` leaves it as it is;
 * "Reload" fetches the stored server, shows it next to the draft and uses its revision for the next save.
 */
export function McpForm({
  server,
  onClose,
}: {
  server: McpServer | undefined;
  onClose: () => void;
}) {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  const editing = server !== undefined;
  const [name, setName] = useState(server?.name ?? "");
  const [url, setUrl] = useState(server?.url ?? "https://");
  const [timeout, setTimeoutText] = useState(
    String(server?.timeoutMs ?? MCP_LIMITS.timeoutMs.default),
  );
  const [maxOutput, setMaxOutput] = useState(
    String(server?.maxOutputBytes ?? MCP_LIMITS.maxOutputBytes.default),
  );
  const [enabled, setEnabled] = useState(server?.enabled ?? true);
  // On create nothing is preselected: `readOnly` must be a deliberate answer.
  const [readOnly, setReadOnly] = useState<Declared>(
    editing ? (server.readOnly ? "yes" : "no") : "",
  );
  const [reasked, setReasked] = useState(false);
  const [baseRevision, setBaseRevision] = useState(server?.revision);
  const [stored, setStored] = useState<McpServer | undefined>(undefined);
  const [saved, setSaved] = useState<McpServer | undefined>(undefined);

  const urlChanged = editing && !sameUrl(url, server.url);
  // A changed URL is a different server: the declaration has to be made again for it.
  const mustReask = urlChanged;
  const readOnlyAnswered = readOnly !== "" && (!mustReask || reasked);

  const problems: string[] = [];
  if (!editing && !MCP_NAME.test(name))
    problems.push(
      "the name starts with a letter and has up to 32 lowercase letters, digits or hyphens",
    );
  const urlIssue = urlProblem(url);
  if (urlIssue !== undefined) problems.push(urlIssue);
  const timeoutIssue = numberProblem("timeoutMs", timeout, MCP_LIMITS.timeoutMs);
  if (timeoutIssue !== undefined) problems.push(timeoutIssue);
  const outputIssue = numberProblem("maxOutputBytes", maxOutput, MCP_LIMITS.maxOutputBytes);
  if (outputIssue !== undefined) problems.push(outputIssue);
  if (!readOnlyAnswered) problems.push("declare whether the server is read-only");

  const changes: Partial<McpFields> = {};
  if (editing) {
    if (urlChanged) changes.url = url;
    if (Number(timeout) !== server.timeoutMs && timeoutIssue === undefined)
      changes.timeoutMs = Number(timeout);
    if (Number(maxOutput) !== server.maxOutputBytes && outputIssue === undefined)
      changes.maxOutputBytes = Number(maxOutput);
    if (mustReask || (readOnly === "yes") !== server.readOnly)
      changes.readOnly = readOnly === "yes";
  }
  const nothingChanged = editing && Object.keys(changes).length === 0;

  const save = useMutation({
    mutationFn: () =>
      putMcpServer(
        token ?? "",
        editing ? server.name : name,
        editing
          ? changes
          : {
              url,
              readOnly: readOnly === "yes",
              enabled,
              timeoutMs: Number(timeout),
              maxOutputBytes: Number(maxOutput),
            },
        editing ? baseRevision : undefined,
      ),
    onSuccess: async (result) => {
      setSaved(result);
      await queryClient.invalidateQueries({ queryKey: ["mcp"] });
    },
  });

  const reload = useMutation({
    mutationFn: async () => {
      const catalog = await listMcpServers(token ?? "");
      return catalog.servers.find((candidate) => candidate.name === server?.name);
    },
    onSuccess: async (latest) => {
      setStored(latest);
      if (latest !== undefined) setBaseRevision(latest.revision);
      save.reset();
      await queryClient.invalidateQueries({ queryKey: ["mcp"] });
    },
  });

  if (saved !== undefined) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Saved {saved.name}</CardTitle>
          <CardDescription>
            Revision {saved.revision}. Existing sessions whose snapshots reference it are affected.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <Link
            className="text-sm underline"
            to={`/profiles?addMcp=${encodeURIComponent(saved.name)}`}
          >
            Add {saved.name} to a profile
          </Link>
          <Button size="sm" variant="outline" onClick={onClose}>
            Done
          </Button>
        </CardContent>
      </Card>
    );
  }

  const conflict = save.error instanceof ApiError && save.error.status === 409;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{editing ? `Edit ${server.name}` : "Register an MCP server"}</CardTitle>
        <CardDescription>
          Transport is fixed to Streamable HTTP and the URL must be https. Hosts also need an OneCLI
          host rule; the console does not probe the network, so reachability stays unknown.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex max-w-xl flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          {!editing && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="mcp-name">Name</Label>
              <Input id="mcp-name" value={name} onChange={(event) => setName(event.target.value)} />
              <p className="text-xs text-muted-foreground">
                Fixed once saved. It becomes the tool prefix{" "}
                <code>mcp__{name === "" ? "name" : name}__</code>.
              </p>
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mcp-url">URL</Label>
            <Input id="mcp-url" value={url} onChange={(event) => setUrl(event.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="mcp-timeout">timeoutMs</Label>
              <Input
                id="mcp-timeout"
                value={timeout}
                onChange={(event) => setTimeoutText(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">1000 to 300000</p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="mcp-output">maxOutputBytes</Label>
              <Input
                id="mcp-output"
                value={maxOutput}
                onChange={(event) => setMaxOutput(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                1024 to 24576; it can only tighten the cut
              </p>
            </div>
          </div>
          {editing && (
            <p className="text-sm">
              <span className="text-muted-foreground">onecliSecret</span>{" "}
              {server.onecliSecret ?? "none"}{" "}
              <span className="text-xs text-muted-foreground">(read-only until #42)</span>
            </p>
          )}
          {!editing && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(event) => setEnabled(event.target.checked)}
              />
              Enabled
            </label>
          )}
          {mustReask && (
            <Alert>
              The URL changed. Declare read-only again for the new address before saving.
            </Alert>
          )}
          <ReadOnlyChoice
            value={mustReask && !reasked ? "" : readOnly}
            onChange={(value) => {
              setReadOnly(value);
              setReasked(true);
            }}
            prompt={editing ? "Read-only declaration" : "Is this server read-only?"}
          />
          {problems.length > 0 && (
            <ul className="list-disc pl-5 text-xs text-muted-foreground">
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          )}
          {save.isError && (
            <Alert variant="destructive">
              {save.error.message}
              {conflict && (
                <span className="mt-2 flex flex-col gap-2">
                  <span>Someone else changed or removed this server. Your draft is kept.</span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => reload.mutate()}
                    disabled={reload.isPending}
                  >
                    Reload the stored server
                  </Button>
                </span>
              )}
            </Alert>
          )}
          {stored !== undefined && (
            <Alert>
              Stored now (revision {stored.revision}, by {stored.updatedBy}):{" "}
              <code>{stored.url}</code>, timeoutMs {stored.timeoutMs}, maxOutputBytes{" "}
              {stored.maxOutputBytes}, readOnly {String(stored.readOnly)},{" "}
              {stored.enabled ? "enabled" : "disabled"}. Saving again replaces these with your
              draft.
            </Alert>
          )}
          {reload.isSuccess && reload.data === undefined && (
            <Alert variant="destructive">
              That server no longer exists. Your draft is kept; cancel to leave.
            </Alert>
          )}
          {reload.isError && <Alert variant="destructive">{reload.error.message}</Alert>}
          <div className="flex gap-2">
            <Button
              type="submit"
              disabled={problems.length > 0 || nothingChanged || save.isPending}
            >
              {editing ? "Save changes" : "Register"}
            </Button>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            {nothingChanged && (
              <span className="self-center text-xs text-muted-foreground">No changes yet.</span>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
