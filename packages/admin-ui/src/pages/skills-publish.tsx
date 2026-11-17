import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useEffect, useRef, useState } from "react";
import type { DragEvent } from "react";
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
  changeSummary,
  decodeText,
  deriveSkillName,
  diffManifest,
  formatBytes,
  fromBase64,
  prepareBundle,
  textDiff,
  toPublishFiles,
} from "@/lib/skills/bundle";
import type { PreparedBundle, PreparedFile, RawEntry } from "@/lib/skills/bundle";
import { readDrop, readFolder, readZipFile, zipBaseName } from "@/lib/skills/read-input";
import { SKILL_NAME } from "@/lib/skills/limits";
import { useCatalogMode } from "@/lib/use-catalog-mode";

/** The route segment of "Publish a skill": the name comes from the chosen folder or zip, not from the address. */
export const NEW_SKILL = "_new";

/** Chrome's `webkitdirectory` is not in React's types; the attribute is what makes the input a folder picker. */
function setDirectory(element: HTMLInputElement | null): void {
  element?.setAttribute("webkitdirectory", "");
}

/** One place to give a skill: drop a folder or a .zip on it, or use the button and pick which. */
function Chooser({ onChosen }: { onChosen: (read: Chosen) => void }) {
  const [menu, setMenu] = useState(false);
  const [over, setOver] = useState(false);
  const folder = useRef<HTMLInputElement | null>(null);
  const zip = useRef<HTMLInputElement | null>(null);
  const onDrop = (event: DragEvent): void => {
    event.preventDefault();
    setOver(false);
    onChosen({ read: () => readDrop(event.dataTransfer) });
  };
  return (
    <div
      className={`flex flex-col items-start gap-3 rounded-lg border-2 border-dashed p-6 ${over ? "border-primary bg-muted" : ""}`}
      onDragOver={(event) => {
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      <div className="relative">
        <Button onClick={() => setMenu((shown) => !shown)} aria-expanded={menu}>
          Choose a folder or a .zip
        </Button>
        {menu && (
          <div className="absolute z-10 mt-1 flex min-w-40 flex-col rounded-md border bg-card p-1 shadow-sm">
            <Button
              size="sm"
              variant="ghost"
              className="justify-start"
              onClick={() => {
                setMenu(false);
                folder.current?.click();
              }}
            >
              Folder
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="justify-start"
              onClick={() => {
                setMenu(false);
                zip.current?.click();
              }}
            >
              Zip file
            </Button>
          </div>
        )}
      </div>
      <span className="text-xs text-muted-foreground">or drop it here</span>
      <input
        aria-label="Folder"
        className="sr-only"
        tabIndex={-1}
        type="file"
        multiple
        ref={(element) => {
          folder.current = element;
          setDirectory(element);
        }}
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          if (files.length > 0)
            onChosen({
              read: async () => ({
                entries: await readFolder(files),
                label: `folder (${String(files.length)} files)`,
                fallback: undefined,
              }),
            });
        }}
      />
      <input
        aria-label="Zip"
        className="sr-only"
        tabIndex={-1}
        type="file"
        accept=".zip,application/zip"
        ref={zip}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file !== undefined)
            onChosen({
              read: async () => ({
                entries: await readZipFile(file),
                label: `zip ${file.name}`,
                fallback: zipBaseName(file.name),
              }),
            });
        }}
      />
    </div>
  );
}

interface Chosen {
  read: () => Promise<{ entries: RawEntry[]; label: string; fallback: string | undefined }>;
}

function ChangeBadge({ kind }: { kind: string }) {
  return <Badge variant={kind === "removed" ? "destructive" : "warning"}>{kind}</Badge>;
}

/** Line diff of a changed text file against the current version (its content is fetched when this shows). */
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
    return <p className="text-xs">A binary file changed.</p>;
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
  identical,
  setExecutable,
}: {
  name: string;
  bundle: PreparedBundle;
  existing: SkillDetail | null | undefined;
  identical: boolean;
  setExecutable: (path: string, executable: boolean) => void;
}) {
  const [open, setOpen] = useState<string | undefined>(undefined);
  const currentVersion = existing?.versions.find(
    (version) => version.version === existing.currentVersion,
  );
  const changes =
    currentVersion === undefined ? undefined : diffManifest(currentVersion.files, bundle.files);
  const byPath = new Map(changes?.map((change) => [change.path, change]));
  const summary = changes === undefined ? [] : changeSummary(changes);
  const rows: { path: string; removed: boolean; file: PreparedFile | undefined }[] = [
    ...bundle.files.map((file) => ({ path: file.path, removed: false, file })),
    ...(changes ?? [])
      .filter((change) => change.kind === "removed")
      .map((change) => ({ path: change.path, removed: true, file: undefined })),
  ];
  const changedText = bundle.files.filter((file) => {
    const change = byPath.get(file.path);
    return change?.kind === "changed" && change.contentChanged && file.text !== null;
  });
  return (
    <div className="flex flex-col gap-4">
      {bundle.problems.length > 0 && (
        <Alert variant="destructive">
          <p className="font-medium">The API would refuse this:</p>
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
          <dd>
            {name} {bundle.meta.disableModelInvocation && <Badge>manual only</Badge>}
          </dd>
          <dt className="text-muted-foreground">Description</dt>
          <dd className="break-words">{bundle.meta.description}</dd>
        </dl>
      )}
      {existing === null && <p className="text-sm">This is the first version of {name}.</p>}
      {identical && (
        <Alert>
          <span data-testid="identical">No changes {"—"} nothing to publish.</span>
        </Alert>
      )}
      {changes !== undefined && !identical && summary.length > 0 && (
        <p className="text-sm" data-testid="diff-summary">
          Against v{currentVersion?.version}:{" "}
          {summary.map(({ kind, count }) => `${String(count)} ${kind}`).join(", ")}
        </p>
      )}
      <Table>
        <thead>
          <tr>
            <Th>File</Th>
            <Th>Size</Th>
            <Th>
              <span className="sr-only">Content</span>
            </Th>
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
                  <Td className="break-all">
                    {path}{" "}
                    {change !== undefined && change.kind !== "unchanged" && (
                      <ChangeBadge kind={change.kind} />
                    )}
                    {file !== undefined && (
                      <label className="ml-2 inline-flex items-center gap-1 text-xs">
                        <input
                          type="checkbox"
                          aria-label={`${path} executable`}
                          checked={file.executable}
                          onChange={(event) => setExecutable(path, event.target.checked)}
                        />
                        executable
                      </label>
                    )}
                  </Td>
                  <Td>{file === undefined ? "" : formatBytes(file.size)}</Td>
                  <Td>
                    {file !== undefined && file.text !== null && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setOpen(open === path ? undefined : path)}
                      >
                        View
                      </Button>
                    )}
                    {file !== undefined && file.text === null && (
                      <span className="text-xs text-muted-foreground">
                        Binary file ({formatBytes(file.size)}), not shown.
                      </span>
                    )}
                  </Td>
                </tr>
                {open === path && file?.text != null && (
                  <tr>
                    <Td colSpan={3}>
                      <pre className="max-h-96 overflow-auto rounded-md border bg-muted p-3 text-xs whitespace-pre-wrap break-words">
                        {file.text}
                      </pre>
                    </Td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </Table>
      {currentVersion !== undefined &&
        changedText.map((file) => (
          <div key={file.path} className="flex flex-col gap-1" data-testid={`diff-${file.path}`}>
            <p className="text-xs font-medium">{file.path}</p>
            <FileDiff skill={name} version={currentVersion.version} file={file} />
          </div>
        ))}
    </div>
  );
}

export function SkillPublish() {
  const { token } = useAuth();
  const { mode } = useCatalogMode();
  const queryClient = useQueryClient();
  const param = useParams().name ?? "";
  // On a skill's own page the name is given; from "Publish a skill" it comes from the chosen folder or zip.
  const expected = param === NEW_SKILL ? undefined : param;
  const [chosen, setChosen] = useState<
    { entries: RawEntry[]; label: string; fallback: string | undefined } | undefined
  >(undefined);
  const [readError, setReadError] = useState<string | undefined>(undefined);
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [bundle, setBundle] = useState<PreparedBundle | undefined>(undefined);

  const derived =
    chosen === undefined
      ? undefined
      : deriveSkillName(chosen.entries, { expected, fallback: chosen.fallback });
  const name = derived?.ok === true ? derived.name : undefined;

  const existing = useQuery({
    queryKey: ["skill", name],
    enabled: name !== undefined,
    queryFn: async ({ signal }) => {
      try {
        return await getSkill(token ?? "", name ?? "", signal);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
  });

  useEffect(() => {
    if (chosen === undefined || name === undefined) return;
    let cancelled = false;
    void prepareBundle(chosen.entries, name, overrides).then((prepared) => {
      if (!cancelled) setBundle(prepared);
    });
    return () => {
      cancelled = true;
    };
  }, [chosen, name, overrides]);

  const publish = useMutation({
    mutationFn: () =>
      publishSkillVersion(token ?? "", name ?? "", toPublishFiles(bundle?.files ?? [])),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["skills"] });
      await queryClient.invalidateQueries({ queryKey: ["skill", name] });
    },
  });

  async function load(next: Chosen): Promise<void> {
    setReadError(undefined);
    setOverrides(new Map());
    setBundle(undefined);
    publish.reset();
    try {
      setChosen(await next.read());
    } catch (error) {
      setChosen(undefined);
      setReadError(error instanceof Error ? error.message : "could not read the input");
    }
  }

  if (expected !== undefined && !SKILL_NAME.test(expected))
    return <Alert variant="destructive">"{expected}" is not a valid skill name.</Alert>;
  if (mode === "readOnly")
    return (
      <Alert>
        Skills are read-only in this console.{" "}
        <Link className="underline" to="/skills">
          Back to skills
        </Link>
      </Alert>
    );

  const currentVersion = existing.data?.versions.find(
    (version) => version.version === existing.data?.currentVersion,
  );
  const identical =
    currentVersion !== undefined &&
    bundle?.digest !== undefined &&
    bundle.digest === currentVersion.digest;
  const ready =
    name !== undefined &&
    bundle !== undefined &&
    bundle.problems.length === 0 &&
    existing.isSuccess &&
    !identical &&
    !publish.isPending;
  const result = publish.data;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>
            {expected === undefined ? "Publish a skill" : `Publish a new version of ${expected}`}
          </CardTitle>
          {expected === undefined && (
            <CardDescription>The name comes from the SKILL.md in it.</CardDescription>
          )}
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Chooser onChosen={(next) => void load(next)} />
          {readError !== undefined && <Alert variant="destructive">{readError}</Alert>}
          {derived?.ok === false && <Alert variant="destructive">{derived.message}</Alert>}
          {existing.isError && <Alert variant="destructive">{existing.error.message}</Alert>}
        </CardContent>
      </Card>

      {name !== undefined && bundle === undefined && <p className="text-sm">Reading...</p>}
      {name !== undefined && bundle !== undefined && result === undefined && (
        <Card>
          <CardHeader>
            <CardTitle>Review</CardTitle>
            <CardDescription>From {chosen?.label}.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Review
              name={name}
              bundle={bundle}
              existing={existing.data}
              identical={identical}
              setExecutable={(path, executable) =>
                setOverrides((old) => new Map(old).set(path, executable))
              }
            />
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
      {name !== undefined && result !== undefined && (
        <Card>
          <CardHeader>
            <CardTitle>
              {result.created
                ? `Published ${name} v${String(result.version.version)}.`
                : "No changes — nothing to publish."}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-3">
            {result.created && (
              <Link
                className="text-sm underline"
                to={`/profiles?pinSkill=${encodeURIComponent(name)}@${String(result.version.version)}`}
              >
                Pin {name} v{result.version.version} in a profile
              </Link>
            )}
            <Link className="text-sm underline" to={`/skills/${encodeURIComponent(name)}`}>
              Back to {name}
            </Link>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
