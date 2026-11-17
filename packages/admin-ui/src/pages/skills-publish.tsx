import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { useAuth } from "@/auth";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, Td, Th } from "@/components/ui/table";
import { ApiError } from "@/lib/api";
import { getSkill, getSkillVersionContent, publishSkillVersion } from "@/lib/api/skills";
import type { SkillDetail } from "@/lib/api/skills";
import {
  decodeText,
  fromBase64,
  diffManifest,
  formatBytes,
  prepareBundle,
  textDiff,
  toPublishFiles,
} from "@/lib/skills/bundle";
import type { PreparedBundle, PreparedFile, RawEntry } from "@/lib/skills/bundle";
import { shortHash } from "@/lib/format";
import { readFolder, readZipFile } from "@/lib/skills/read-input";
import { SKILL_LIMITS, SKILL_NAME } from "@/lib/skills/limits";
import { useCatalogMode } from "@/lib/use-catalog-mode";

/** Chrome's `webkitdirectory` is not in React's types; the attribute is what makes the input a folder picker. */
function setDirectory(element: HTMLInputElement | null): void {
  element?.setAttribute("webkitdirectory", "");
}

function ChangeBadge({ kind, mode }: { kind: string; mode: boolean }) {
  const variant = kind === "removed" ? "destructive" : kind === "unchanged" ? "outline" : "warning";
  return (
    <Badge variant={variant}>
      {kind}
      {kind === "changed" && mode ? " (executable bit)" : ""}
    </Badge>
  );
}

/** Line diff of a changed text file against the current version (its content is fetched when this opens). */
function FileDiff({
  skill,
  version,
  file,
}: {
  skill: string;
  version: number;
  file: PreparedFile;
}) {
  const { token } = useAuth();
  const current = useQuery({
    queryKey: ["skill-content", skill, version],
    queryFn: ({ signal }) => getSkillVersionContent(token ?? "", skill, version, signal),
  });
  if (current.isError) return <Alert variant="destructive">{current.error.message}</Alert>;
  if (!current.isSuccess) return <p className="text-xs">Loading the current version...</p>;
  const old = current.data.files.find((candidate) => candidate.path === file.path);
  const before = old?.contentBase64 == null ? null : decodeText(fromBase64(old.contentBase64));
  if (file.text === null || before === null)
    return <p className="text-xs">A binary file changed: compare the sha256 values above.</p>;
  return (
    <pre className="max-h-96 overflow-auto rounded-md border bg-muted p-3 text-xs">
      {textDiff(before, file.text).map((line, index) => (
        <div
          key={index}
          className={
            line.kind === "added"
              ? "bg-green-500/15"
              : line.kind === "removed"
                ? "bg-red-500/15"
                : undefined
          }
        >
          {line.kind === "added" ? "+ " : line.kind === "removed" ? "- " : "  "}
          {line.text}
        </div>
      ))}
    </pre>
  );
}

function Review({
  name,
  bundle,
  existing,
  setExecutable,
}: {
  name: string;
  bundle: PreparedBundle;
  existing: SkillDetail | null | undefined;
  setExecutable: (path: string, executable: boolean) => void;
}) {
  const [open, setOpen] = useState<{ path: string; mode: "view" | "diff" } | undefined>(undefined);
  const currentVersion = existing?.versions.find(
    (version) => version.version === existing.currentVersion,
  );
  const changes =
    currentVersion === undefined ? undefined : diffManifest(currentVersion.files, bundle.files);
  const byPath = new Map(changes?.map((change) => [change.path, change]));
  const rows: { path: string; removed: boolean; file: PreparedFile | undefined }[] = [
    ...bundle.files.map((file) => ({ path: file.path, removed: false, file })),
    ...(changes ?? [])
      .filter((change) => change.kind === "removed")
      .map((change) => ({ path: change.path, removed: true, file: undefined })),
  ];
  return (
    <div className="flex flex-col gap-4">
      {bundle.problems.length > 0 && (
        <Alert variant="destructive">
          <p className="font-medium">The API would refuse this bundle:</p>
          <ul className="list-disc pl-5">
            {bundle.problems.map((problem) => (
              <li key={problem} className="break-words">
                {problem}
              </li>
            ))}
          </ul>
        </Alert>
      )}
      {bundle.ignored.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Left out (not part of a skill): {bundle.ignored.join(", ")}
        </p>
      )}
      {bundle.meta?.ok === true && (
        <dl
          className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm"
          aria-label="Parsed SKILL.md"
        >
          <dt className="text-muted-foreground">Name</dt>
          <dd>{name}</dd>
          <dt className="text-muted-foreground">Description</dt>
          <dd className="break-words">{bundle.meta.description}</dd>
          <dt className="text-muted-foreground">Model invocation</dt>
          <dd>
            {bundle.meta.disableModelInvocation
              ? "disabled (kept out of the model's catalog)"
              : "enabled"}
          </dd>
          <dt className="text-muted-foreground">Total</dt>
          <dd>
            {bundle.files.length} files, {formatBytes(bundle.totalBytes)}
          </dd>
        </dl>
      )}
      {existing === null && <p className="text-sm">This is the first version of {name}.</p>}
      {currentVersion !== undefined &&
        bundle.digest !== undefined &&
        bundle.digest === currentVersion.digest && (
          <Alert>
            Identical to v{currentVersion.version}: publishing will create no new version.
          </Alert>
        )}
      {changes !== undefined && (
        <p className="text-sm" data-testid="diff-summary">
          Against v{currentVersion?.version}:{" "}
          {(["added", "removed", "changed", "unchanged"] as const)
            .map(
              (kind) =>
                `${String(changes.filter((change) => change.kind === kind).length)} ${kind}`,
            )
            .join(", ")}
        </p>
      )}
      <Table>
        <thead>
          <tr>
            <Th>Path</Th>
            <Th>Size</Th>
            <Th>sha256</Th>
            <Th>Executable</Th>
            {changes !== undefined && <Th>Against current</Th>}
            <Th>Content</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ path, removed, file }) => {
            const change = byPath.get(path);
            return (
              <Fragment key={`${removed ? "removed:" : ""}${path}`}>
                <tr
                  data-testid={`file-${path}`}
                  className={removed ? "text-muted-foreground line-through" : undefined}
                >
                  <Td className="break-all">{path}</Td>
                  <Td>{file === undefined ? "" : formatBytes(file.size)}</Td>
                  <Td>
                    {file === undefined ? (
                      ""
                    ) : (
                      <code title={file.sha256}>{shortHash(file.sha256)}</code>
                    )}
                  </Td>
                  <Td>
                    {file !== undefined && (
                      <label className="flex items-center gap-1 text-xs">
                        <input
                          type="checkbox"
                          aria-label={`${path} executable`}
                          checked={file.executable}
                          onChange={(event) => setExecutable(path, event.target.checked)}
                        />
                        {file.executable ? "chmod 755" : "no"}
                      </label>
                    )}
                  </Td>
                  {changes !== undefined && (
                    <Td>
                      {change !== undefined && (
                        <ChangeBadge kind={change.kind} mode={change.modeChanged} />
                      )}
                    </Td>
                  )}
                  <Td>
                    {file !== undefined && file.text !== null && (
                      <span className="flex gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            setOpen(
                              open?.path === path && open.mode === "view"
                                ? undefined
                                : { path, mode: "view" },
                            )
                          }
                        >
                          View
                        </Button>
                        {change?.kind === "changed" && change.contentChanged && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              setOpen(
                                open?.path === path && open.mode === "diff"
                                  ? undefined
                                  : { path, mode: "diff" },
                              )
                            }
                          >
                            Diff
                          </Button>
                        )}
                      </span>
                    )}
                    {file !== undefined && file.text === null && (
                      <span className="text-xs text-muted-foreground">binary: digest only</span>
                    )}
                  </Td>
                </tr>
                {open?.path === path && file?.text != null && (
                  <tr>
                    <Td colSpan={6}>
                      {open.mode === "view" ? (
                        <pre className="max-h-96 overflow-auto rounded-md border bg-muted p-3 text-xs whitespace-pre-wrap break-words">
                          {file.text}
                        </pre>
                      ) : (
                        currentVersion !== undefined && (
                          <FileDiff skill={name} version={currentVersion.version} file={file} />
                        )
                      )}
                    </Td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </Table>
    </div>
  );
}

export function SkillPublish() {
  const { token } = useAuth();
  const { mode } = useCatalogMode();
  const queryClient = useQueryClient();
  const name = useParams().name ?? "";
  const [entries, setEntries] = useState<RawEntry[] | undefined>(undefined);
  const [source, setSource] = useState("");
  const [readError, setReadError] = useState<string | undefined>(undefined);
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [bundle, setBundle] = useState<PreparedBundle | undefined>(undefined);
  const [confirmed, setConfirmed] = useState(false);

  const existing = useQuery({
    queryKey: ["skill", name],
    queryFn: async ({ signal }) => {
      try {
        return await getSkill(token ?? "", name, signal);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
  });

  useEffect(() => {
    if (entries === undefined) return;
    let cancelled = false;
    void prepareBundle(entries, name, overrides).then((prepared) => {
      if (!cancelled) setBundle(prepared);
    });
    return () => {
      cancelled = true;
    };
  }, [entries, name, overrides]);

  const publish = useMutation({
    mutationFn: () => publishSkillVersion(token ?? "", name, toPublishFiles(bundle?.files ?? [])),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["skills"] });
      await queryClient.invalidateQueries({ queryKey: ["skill", name] });
    },
  });

  async function load(label: string, read: () => Promise<RawEntry[]>): Promise<void> {
    setReadError(undefined);
    setConfirmed(false);
    setOverrides(new Map());
    setBundle(undefined);
    publish.reset();
    try {
      const read_ = await read();
      setEntries(read_);
      setSource(label);
    } catch (error) {
      setEntries(undefined);
      setReadError(error instanceof Error ? error.message : "could not read the input");
    }
  }

  if (!SKILL_NAME.test(name))
    return <Alert variant="destructive">"{name}" is not a valid skill name.</Alert>;
  if (mode === "readOnly")
    return (
      <Alert>
        Skills are read-only in this console.{" "}
        <Link className="underline" to={`/skills/${encodeURIComponent(name)}`}>
          Back to {name}
        </Link>
      </Alert>
    );

  const ready =
    bundle !== undefined && bundle.problems.length === 0 && confirmed && !publish.isPending;
  const result = publish.data;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Publish {name}</CardTitle>
          <CardDescription>
            Choose the skill's folder or a .zip. It is read in your browser and sent to the API only
            when you publish. Limits: at most {SKILL_LIMITS.files} files and 5 MiB, SKILL.md of at
            most 32 KiB with a description in its frontmatter, regular files only. The API checks
            again and has the last word.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-6">
          <div className="flex flex-col gap-1.5 text-sm">
            <label htmlFor="skill-folder" className="font-medium">
              Folder
            </label>
            <input
              id="skill-folder"
              type="file"
              multiple
              ref={setDirectory}
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                if (files.length > 0)
                  void load(`folder (${String(files.length)} files)`, () => readFolder(files));
              }}
            />
            <span className="text-xs text-muted-foreground">
              A folder cannot tell the executable bit: set it below.
            </span>
          </div>
          <div className="flex flex-col gap-1.5 text-sm">
            <label htmlFor="skill-zip" className="font-medium">
              Zip
            </label>
            <input
              id="skill-zip"
              type="file"
              accept=".zip,application/zip"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file !== undefined) void load(`zip ${file.name}`, () => readZipFile(file));
              }}
            />
            <span className="text-xs text-muted-foreground">
              The executable bit is read from the zip when it has one.
            </span>
          </div>
        </CardContent>
      </Card>

      {readError !== undefined && <Alert variant="destructive">{readError}</Alert>}
      {existing.isError && <Alert variant="destructive">{existing.error.message}</Alert>}

      {entries !== undefined && bundle === undefined && (
        <p className="text-sm">Reading and hashing...</p>
      )}
      {bundle !== undefined && result === undefined && (
        <Card>
          <CardHeader>
            <CardTitle>Review</CardTitle>
            <CardDescription>From {source}.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Review
              name={name}
              bundle={bundle}
              existing={existing.data}
              setExecutable={(path, executable) =>
                setOverrides((old) => new Map(old).set(path, executable))
              }
            />
            <Alert variant="destructive" className="border-amber-500/50 text-foreground">
              <p>
                Publishing deploys code that runs in every session that pins this skill. Files
                marked executable are made runnable in the sandbox and the model runs them with the
                bash tool. Binaries must match the nodes' architecture.
              </p>
              <label className="mt-2 flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                I have reviewed these files and want to publish them
              </label>
            </Alert>
            {publish.isError && (
              <Alert variant="destructive">
                <span className="font-medium">The API refused the publish: </span>
                {publish.error.message}
              </Alert>
            )}
            <div>
              <Button onClick={() => publish.mutate()} disabled={!ready}>
                Publish {name}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
      {result !== undefined && (
        <Card>
          <CardHeader>
            <CardTitle>
              {result.created
                ? `Published v${String(result.version.version)}`
                : "Nothing was published"}
            </CardTitle>
            <CardDescription>
              {result.created
                ? `${name} v${String(result.version.version)} has digest ${result.version.digest}. Profiles keep their current pins until someone pins it.`
                : `The content is identical to the current version, v${String(result.version.version)}: the API created no new version.`}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-3">
            <Link
              className="text-sm underline"
              to={`/profiles?pinSkill=${encodeURIComponent(name)}@${String(result.version.version)}`}
            >
              Pin {name} v{result.version.version} in a profile
            </Link>
            <Link className="text-sm underline" to={`/skills/${encodeURIComponent(name)}`}>
              Back to {name}
            </Link>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
