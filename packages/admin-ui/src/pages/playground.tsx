import { useMutation } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SyntheticEvent } from "react";
import { Link, useSearchParams } from "react-router";
import { useAuth } from "@/auth";
import { Time } from "@/components/time";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ApiError } from "@/lib/api";
import { createSession, deleteSession, getSession, postSessionEvent } from "@/lib/api/sessions";
import type { CreateSessionBody } from "@/lib/api/sessions";
import { REASONING_LEVELS } from "@/lib/api/settings";
import { idOf, keyOf, providerOf } from "@/lib/models";
import {
  disabledMcpOf,
  loadStoredSessions,
  profileForMcp,
  saveStoredSessions,
} from "@/lib/playground";
import type { StoredSession } from "@/lib/playground";
import { useMcpPickerQuery, useProfilesQuery, useSandboxSizesQuery } from "@/lib/queries";
import { useModelView } from "@/lib/use-models";
import { useSessionStream } from "@/lib/use-session-stream";
import type { Connection } from "@/lib/use-session-stream";
import { Transcript } from "@/pages/playground-transcript";

/** What the page shows of the session it follows; the answer of `POST /sessions`, or `GET /sessions/{id}` for a resumed one. */
interface ActiveSession {
  id: string;
  profile: { name: string; version: number };
  model: string;
  reasoning: string | undefined;
  sandboxSize: string | undefined;
  /** Set once the DELETE was accepted: the transcript stays for reading, nothing more is sent. */
  ended: boolean;
}

const CONNECTION_TEXT: Record<Connection, string> = {
  idle: "not connected",
  connecting: "connecting",
  open: "connected",
  reconnecting: "reconnecting",
  gone: "session ended",
  failed: "stream refused",
};

const isGone = (error: unknown): boolean =>
  error instanceof ApiError && (error.status === 404 || error.status === 410);

function CostNote() {
  return (
    <Alert variant="warning">
      <strong>This is a real session.</strong> Starting one creates a sandbox and its workspace
      volume, and every message spends model tokens as the signed-in owner. Tools such as shell
      commands and MCP servers really run. End the session when you are done; leaving or closing
      this page asks to end it.
    </Alert>
  );
}

function StartForm({
  initialProfile,
  onStarted,
}: {
  initialProfile: string | undefined;
  onStarted: (session: ActiveSession) => void;
}) {
  const { token } = useAuth();
  const profiles = useProfilesQuery();
  const mcp = useMcpPickerQuery();
  const sizes = useSandboxSizesQuery();
  const models = useModelView();
  const [profile, setProfile] = useState<string | undefined>(undefined);
  const [model, setModel] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [size, setSize] = useState("");
  const [formError, setFormError] = useState<string | undefined>(undefined);

  const open = (profiles.data?.profiles ?? []).filter((entry) => entry.enabledForNew);
  const chosen =
    profile ??
    (open.some((p) => p.name === initialProfile) ? initialProfile : undefined) ??
    profiles.data?.defaultProfile ??
    "";
  const definition = open.find((entry) => entry.name === chosen)?.definition;
  const servers = definition?.mcpServers ?? [];
  const disabled = disabledMcpOf(servers, mcp.data ?? []);

  const start = useMutation({
    mutationFn: (body: CreateSessionBody) => createSession(token ?? "", body),
    onSuccess: (created) => {
      const stored = loadStoredSessions().filter((entry) => entry.id !== created.sessionId);
      saveStoredSessions([
        ...stored,
        {
          id: created.sessionId,
          profile: created.profile.name,
          startedAt: new Date().toISOString(),
        },
      ]);
      onStarted({
        id: created.sessionId,
        profile: created.profile,
        model: `${created.provider}/${created.model}`,
        reasoning: created.reasoning,
        sandboxSize: created.sandboxSize,
        ended: false,
      });
    },
  });

  const submit = (event: SyntheticEvent): void => {
    event.preventDefault();
    setFormError(undefined);
    const body: CreateSessionBody = {};
    if (chosen !== "") body.profile = chosen;
    const picked = model.trim();
    if (picked !== "") {
      if (providerOf(picked) === "" || idOf(picked) === "") {
        setFormError("The model is written provider/model, for example openai/gpt-4o.");
        return;
      }
      body.provider = providerOf(picked);
      body.model = idOf(picked);
    }
    if (reasoning !== "") body.reasoning = reasoning;
    if (size !== "") body.sandboxSize = size;
    start.mutate(body);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Start a session</CardTitle>
        <CardDescription>
          The session gets the profile&apos;s definition as it is now, like any new session.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="flex flex-col gap-4" onSubmit={submit}>
          {profiles.isError && <Alert variant="destructive">{profiles.error.message}</Alert>}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pg-profile">Profile</Label>
            <Select id="pg-profile" value={chosen} onChange={(e) => setProfile(e.target.value)}>
              {open.map((entry) => (
                <option key={entry.name} value={entry.name}>
                  {entry.name}
                  {entry.name === profiles.data?.defaultProfile ? " (default)" : ""}
                </option>
              ))}
            </Select>
            <p className="text-xs text-muted-foreground" data-testid="profile-servers">
              {servers.length === 0 ? (
                "No MCP servers."
              ) : (
                <>
                  MCP servers: {servers.join(", ")}
                  {disabled.length > 0 && (
                    <span className="text-destructive">
                      {" "}
                      ({disabled.join(", ")} {disabled.length === 1 ? "is" : "are"} disabled in the
                      catalog, so {disabled.length === 1 ? "its" : "their"} tools will not be
                      offered)
                    </span>
                  )}
                </>
              )}
            </p>
          </div>
          <details className="flex flex-col gap-3">
            <summary className="cursor-pointer text-sm font-medium">Overrides (optional)</summary>
            <div className="mt-3 grid gap-4 md:grid-cols-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="pg-model">Model</Label>
                <Input
                  id="pg-model"
                  list="pg-models"
                  autoComplete="off"
                  placeholder={definition?.defaultModel ?? "the profile's default"}
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                />
                <datalist id="pg-models">
                  {models.models.map((entry) => (
                    <option
                      key={keyOf(entry)}
                      value={keyOf(entry)}
                      label={entry.name ?? entry.id}
                    />
                  ))}
                </datalist>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="pg-reasoning">Reasoning</Label>
                <Select
                  id="pg-reasoning"
                  value={reasoning}
                  onChange={(e) => setReasoning(e.target.value)}
                >
                  <option value="">Profile default</option>
                  {REASONING_LEVELS.map((level) => (
                    <option key={level} value={level}>
                      {level}
                    </option>
                  ))}
                </Select>
              </div>
              {(sizes.data?.sizes.length ?? 0) > 0 && (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="pg-size">Sandbox size</Label>
                  <Select id="pg-size" value={size} onChange={(e) => setSize(e.target.value)}>
                    <option value="">Profile default</option>
                    {sizes.data?.sizes.map((entry) => (
                      <option key={entry.name} value={entry.name}>
                        {entry.name}
                      </option>
                    ))}
                  </Select>
                </div>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              The API refuses a model outside the allowlist, a reasoning level above the cap and a
              size the profile does not allow; its message shows here.
            </p>
          </details>
          {formError !== undefined && <Alert variant="destructive">{formError}</Alert>}
          {start.isError && <Alert variant="destructive">{start.error.message}</Alert>}
          <div>
            <Button type="submit" disabled={start.isPending || chosen === ""}>
              {start.isPending ? "Starting…" : "Start session"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function ConnectionBadge({ connection }: { connection: Connection }) {
  const variant =
    connection === "open" ? "secondary" : connection === "failed" ? "destructive" : "warning";
  return (
    <Badge variant={variant} data-testid="connection">
      {CONNECTION_TEXT[connection]}
    </Badge>
  );
}

function SessionPanel({
  session,
  onEnded,
  onNew,
}: {
  session: ActiveSession;
  onEnded: () => void;
  onNew: () => void;
}) {
  const { token } = useAuth();
  const stream = useSessionStream(token ?? "", session.id);
  const [text, setText] = useState("");
  const finished = session.ended || stream.connection === "gone";
  const live = stream.live;
  const working = live?.running === true || (live?.queued ?? 0) > 0;

  const send = useMutation({
    mutationFn: (message: string) =>
      postSessionEvent(token ?? "", session.id, { kind: "message", text: message }),
    onSuccess: () => setText(""),
  });
  const stop = useMutation({
    mutationFn: () => postSessionEvent(token ?? "", session.id, { kind: "cancel" }),
  });
  const end = useMutation({
    mutationFn: () => deleteSession(token ?? "", session.id),
    onSuccess: onEnded,
    // A session that is already gone is what the operator wanted.
    onError: (error) => {
      if (isGone(error)) onEnded();
    },
  });

  useEffect(() => {
    // The server says it is gone (deleted elsewhere, or the stream's last word): forget it locally too.
    if (stream.connection === "gone" && !session.ended) onEnded();
  }, [stream.connection, session.ended, onEnded]);

  const submit = (event: SyntheticEvent): void => {
    event.preventDefault();
    const message = text.trim();
    if (message !== "" && !finished) send.mutate(message);
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Session</CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <ConnectionBadge connection={finished ? "gone" : stream.connection} />
            {working && !finished && <Badge variant="warning">agent working</Badge>}
          </div>
        </div>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Id</dt>
          <dd>
            <code className="break-all" data-testid="session-id">
              {session.id}
            </code>
          </dd>
          <dt className="text-muted-foreground">Profile</dt>
          <dd>
            <Link
              className="underline"
              to={`/profiles/${encodeURIComponent(session.profile.name)}`}
            >
              {session.profile.name}
            </Link>{" "}
            v{session.profile.version}
          </dd>
          <dt className="text-muted-foreground">Model</dt>
          <dd>
            {session.model}
            {session.reasoning !== undefined && ` (reasoning ${session.reasoning})`}
          </dd>
          {session.sandboxSize !== undefined && (
            <>
              <dt className="text-muted-foreground">Sandbox size</dt>
              <dd>{session.sandboxSize}</dd>
            </>
          )}
        </dl>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {stream.connection === "reconnecting" && !finished && (
          <Alert variant="warning">
            The stream dropped{stream.error !== undefined ? ` (${stream.error})` : ""}; reconnecting
            and resuming after the last message.
          </Alert>
        )}
        {stream.connection === "failed" && <Alert variant="destructive">{stream.error}</Alert>}
        <Transcript items={stream.transcript.items} live={live} />
        {live?.runFailure !== undefined && !working && (
          <Alert variant="destructive" data-testid="run-failure">
            The last run ended without an answer: {live.runFailure}.
          </Alert>
        )}
        {(live?.queued ?? 0) > 0 && (
          <p className="text-xs text-muted-foreground">
            {live?.queued} message(s) queued behind the running turn.
          </p>
        )}
        {finished ? (
          <div className="flex flex-col gap-2">
            <Alert>
              This session has ended. The transcript stays here until you start another.
            </Alert>
            <div>
              <Button onClick={onNew}>Start a new session</Button>
            </div>
          </div>
        ) : (
          <form className="flex flex-col gap-2" onSubmit={submit}>
            <Label htmlFor="pg-message">Message</Label>
            <Textarea
              id="pg-message"
              value={text}
              maxLength={65_536}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(e);
              }}
              placeholder="Ask the agent to use a tool. Ctrl or Cmd + Enter sends."
            />
            {send.isError && <Alert variant="destructive">{send.error.message}</Alert>}
            {stop.isError && <Alert variant="destructive">{stop.error.message}</Alert>}
            {end.isError && !isGone(end.error) && (
              <Alert variant="destructive">{end.error.message}</Alert>
            )}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={send.isPending || text.trim() === ""}>
                {send.isPending ? "Sending…" : "Send"}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={!working || stop.isPending}
                onClick={() => stop.mutate()}
              >
                Stop turn
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={end.isPending}
                onClick={() => end.mutate()}
              >
                {end.isPending ? "Ending…" : "End session"}
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Sessions this browser started that may still run. The session API has no list call, so the console remembers the ids
 * (not secrets) and asks the API about each: one that is gone drops off, the rest can be reopened or ended.
 */
function OpenSessions({
  stored,
  current,
  onChange,
  onOpen,
}: {
  stored: StoredSession[];
  current: string | undefined;
  onChange: (next: StoredSession[]) => void;
  onOpen: (session: ActiveSession) => void;
}) {
  const { token } = useAuth();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const checked = useRef(new Set<string>());
  const latest = useRef(stored);
  latest.current = stored;

  const drop = (id: string): void => {
    const next = latest.current.filter((entry) => entry.id !== id);
    saveStoredSessions(next);
    onChange(next);
  };

  // Verify each remembered id once: the session may have been deleted from another tab or by the sweep.
  useEffect(() => {
    const controller = new AbortController();
    for (const entry of stored) {
      if (checked.current.has(entry.id)) continue;
      checked.current.add(entry.id);
      getSession(token ?? "", entry.id, controller.signal).then(
        (info) => {
          if (info.status === "deleted" || info.status === "deleting") drop(entry.id);
        },
        (error: unknown) => {
          if (isGone(error)) drop(entry.id);
        },
      );
    }
    return () => controller.abort();
  }, [stored, token]);

  const end = useMutation({
    mutationFn: (id: string) => deleteSession(token ?? "", id),
    onSuccess: (_void, id) => drop(id),
    onError: (error, id) => {
      if (isGone(error)) drop(id);
      else setErrors((prev) => ({ ...prev, [id]: error.message }));
    },
  });

  const resume = useMutation({
    mutationFn: (id: string) => getSession(token ?? "", id),
    onSuccess: (info) =>
      onOpen({
        id: info.sessionId,
        profile: info.profile,
        model: `${info.model.provider}/${info.model.model}`,
        reasoning: info.model.reasoning,
        sandboxSize: info.sandboxSize,
        ended: false,
      }),
    onError: (error, id) => {
      if (isGone(error)) drop(id);
      else setErrors((prev) => ({ ...prev, [id]: error.message }));
    },
  });

  const others = stored.filter((entry) => entry.id !== current);
  if (others.length === 0) return null;
  return (
    <Card data-testid="open-sessions">
      <CardHeader>
        <CardTitle>Still open</CardTitle>
        <CardDescription>
          Playground sessions started in this browser that were not ended. They keep their sandbox
          until they are deleted or go idle.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {others.map((entry) => (
          <div key={entry.id} className="flex flex-wrap items-center gap-2 text-sm">
            <code className="break-all">{entry.id}</code>
            <span className="text-muted-foreground">
              {entry.profile}, <Time value={entry.startedAt} />
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={resume.isPending}
              onClick={() => resume.mutate(entry.id)}
            >
              Open
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={end.isPending}
              onClick={() => end.mutate(entry.id)}
            >
              End
            </Button>
            {errors[entry.id] !== undefined && (
              <span className="text-destructive">{errors[entry.id]}</span>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/**
 * An admin-only place to try a profile for real: start a session, chat, and read every tool call and result as they
 * happen, for example to check that a newly registered MCP server's tools work. The session is a real one (a sandbox and
 * model tokens), so the page ends it when the operator leaves.
 */
export function PlaygroundPage() {
  const { token } = useAuth();
  const [params] = useSearchParams();
  const profiles = useProfilesQuery();
  const [session, setSession] = useState<ActiveSession | undefined>(undefined);
  const [stored, setStored] = useState<StoredSession[]>(loadStoredSessions);

  const wanted = params.get("profile");
  const viaServer = params.get("mcp");
  const initialProfile =
    wanted ??
    (viaServer === null || profiles.data === undefined
      ? undefined
      : profileForMcp(
          profiles.data.profiles.map((p) => ({
            name: p.name,
            enabledForNew: p.enabledForNew,
            mcpServers: p.definition.mcpServers ?? [],
          })),
          viaServer,
        ));

  const forget = useCallback((id: string): void => {
    const next = loadStoredSessions().filter((entry) => entry.id !== id);
    saveStoredSessions(next);
    setStored(next);
  }, []);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const ended = useCallback((): void => {
    const current = sessionRef.current;
    if (current === undefined || current.ended) return;
    forget(current.id);
    setSession({ ...current, ended: true });
  }, [forget]);

  // A live session is a sandbox and tokens: warn before the tab closes, and end it when the tab goes away or the
  // operator navigates elsewhere in the console.
  const active = session !== undefined && !session.ended ? session.id : undefined;
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const activeRef = useRef(active);
  activeRef.current = active;
  useEffect(() => {
    if (active === undefined) return undefined;
    const warn = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };
    const release = (): void => {
      deleteSession(tokenRef.current ?? "", active, { keepalive: true }).catch(() => undefined);
    };
    window.addEventListener("beforeunload", warn);
    window.addEventListener("pagehide", release);
    return () => {
      window.removeEventListener("beforeunload", warn);
      window.removeEventListener("pagehide", release);
    };
  }, [active]);
  const leaving = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    // React Strict Mode unmounts and remounts at once in development: the deferred end is cancelled by the remount.
    clearTimeout(leaving.current);
    return () => {
      leaving.current = setTimeout(() => {
        const id = activeRef.current;
        if (id === undefined) return;
        deleteSession(tokenRef.current ?? "", id).then(
          () => forget(id),
          () => undefined,
        );
      }, 0);
    };
  }, [forget]);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Playground</CardTitle>
          <CardDescription>
            Try a profile with a real session: chat with the agent and see each tool call and its
            result, MCP tools included.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CostNote />
        </CardContent>
      </Card>
      {session === undefined ? (
        <StartForm initialProfile={initialProfile} onStarted={setSession} />
      ) : (
        <SessionPanel session={session} onEnded={ended} onNew={() => setSession(undefined)} />
      )}
      <OpenSessions
        stored={stored}
        current={session?.ended === true ? undefined : session?.id}
        onChange={setStored}
        onOpen={setSession}
      />
    </div>
  );
}
