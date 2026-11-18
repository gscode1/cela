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
import { CREATE_ONLY_REVISION } from "@/lib/conflict";
import { Time } from "@/components/time";
import {
  fromTyped,
  kbText,
  listMcpServers,
  MCP_LIMITS,
  MCP_NAME,
  OUTPUT_FIELD,
  putMcpServer,
  scaledProblem,
  secondsText,
  TIMEOUT_FIELD,
  toTyped,
  urlProblem,
} from "@/lib/api/mcp";
import type { McpFields, McpServer } from "@/lib/api/mcp";

export type Declared = "yes" | "no" | "";

/**
 * The declaration the operator makes. One MCP client serves every session, so a server that changes state is a
 * different thing to enable than one that only reads.
 */
export function ReadOnlyChoice({
  value,
  onChange,
  prompt = "Does this server change anything?",
}: {
  value: Declared;
  onChange: (value: Declared) => void;
  prompt?: string;
}) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-sm font-medium">{prompt}</legend>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="radio"
          name="readOnly"
          checked={value === "yes"}
          onChange={() => onChange("yes")}
        />
        No, it only reads
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="radio"
          name="readOnly"
          checked={value === "no"}
          onChange={() => onChange("no")}
        />
        Yes, it can change state
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
 * `usedByProfiles`: whether a profile names this server, which decides if the saved message mentions sessions.
 */
export function McpForm({
  server,
  usedByProfiles,
  onClose,
}: {
  server: McpServer | undefined;
  usedByProfiles: boolean;
  onClose: () => void;
}) {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  const editing = server !== undefined;
  const [name, setName] = useState(server?.name ?? "");
  const [url, setUrl] = useState(server?.url ?? "https://");
  const [timeout, setTimeoutText] = useState(
    toTyped(server?.timeoutMs ?? MCP_LIMITS.timeoutMs.default, TIMEOUT_FIELD.scale),
  );
  const [maxOutput, setMaxOutput] = useState(
    toTyped(server?.maxOutputBytes ?? MCP_LIMITS.maxOutputBytes.default, OUTPUT_FIELD.scale),
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
  // What the next save is laid over: after a reload the stored server, so a value set back to what the server had when
  // the form opened is still a change from what is stored now.
  const base = stored ?? server;

  const urlChanged = base !== undefined && !sameUrl(url, base.url);
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
  const timeoutIssue = scaledProblem(TIMEOUT_FIELD, timeout);
  if (timeoutIssue !== undefined) problems.push(timeoutIssue);
  const outputIssue = scaledProblem(OUTPUT_FIELD, maxOutput);
  if (outputIssue !== undefined) problems.push(outputIssue);
  if (!readOnlyAnswered) problems.push("answer whether the server changes anything");

  const timeoutMs = fromTyped(timeout, TIMEOUT_FIELD.scale) ?? MCP_LIMITS.timeoutMs.default;
  const maxOutputBytes =
    fromTyped(maxOutput, OUTPUT_FIELD.scale) ?? MCP_LIMITS.maxOutputBytes.default;
  const changes: Partial<McpFields> = {};
  if (base !== undefined) {
    if (urlChanged) changes.url = url;
    if (timeoutMs !== base.timeoutMs && timeoutIssue === undefined) changes.timeoutMs = timeoutMs;
    if (maxOutputBytes !== base.maxOutputBytes && outputIssue === undefined)
      changes.maxOutputBytes = maxOutputBytes;
    if (mustReask || (readOnly === "yes") !== base.readOnly) changes.readOnly = readOnly === "yes";
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
              timeoutMs,
              maxOutputBytes,
            },
        editing ? baseRevision : CREATE_ONLY_REVISION,
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
          <CardTitle>Saved.</CardTitle>
          {editing && usedByProfiles && (
            <CardDescription>Sessions using it pick up the change.</CardDescription>
          )}
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
        <CardDescription>The host must be allowed in OneCLI&apos;s egress rules.</CardDescription>
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
              <Label htmlFor="mcp-timeout">Timeout (seconds)</Label>
              <Input
                id="mcp-timeout"
                value={timeout}
                onChange={(event) => setTimeoutText(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="mcp-output">Max output (KB)</Label>
              <Input
                id="mcp-output"
                value={maxOutput}
                onChange={(event) => setMaxOutput(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">Cuts longer tool output.</p>
            </div>
          </div>
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
            <Alert>The URL changed. Answer again for the new address before saving.</Alert>
          )}
          <ReadOnlyChoice
            value={mustReask && !reasked ? "" : readOnly}
            onChange={(value) => {
              setReadOnly(value);
              setReasked(true);
            }}
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
              {!conflict
                ? save.error.message
                : editing
                  ? "Someone else changed or removed this server since you opened it."
                  : `Not registered: ${save.error.message}. Nothing was written.`}
              {conflict && editing && (
                <span className="mt-2 flex flex-col gap-2">
                  <span>Your draft is kept.</span>
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
              Changed by {stored.updatedBy} <Time value={stored.updatedAt} /> since you opened it.
              Stored now: <code>{stored.url}</code>, timeout {secondsText(stored.timeoutMs)}, max
              output {kbText(stored.maxOutputBytes)},{" "}
              {stored.readOnly ? "read-only" : "can change state"},{" "}
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
