import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useAuth } from "@/auth";
import { DeleteConfirm } from "@/components/delete-confirm";
import { ProfileLinks } from "@/components/profile-ref-links";
import { ReadOnlyNote } from "@/components/read-only-note";
import { Time } from "@/components/time";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, Td, Th } from "@/components/ui/table";
import { listProfileRefs, profilesPinning, profilesPinningSkill } from "@/lib/api/profile-refs";
import type { ProfileRef } from "@/lib/api/profile-refs";
import { deleteSkill, downloadSkillZip, getSkill, getSkillVersionContent } from "@/lib/api/skills";
import type { SkillVersion } from "@/lib/api/skills";
import { decodeText, formatBytes, fromBase64 } from "@/lib/skills/bundle";
import { useCatalogMode } from "@/lib/use-catalog-mode";

/** A file's content, fetched when asked for: the text as text, a binary only by its size. */
export function FileContent({
  skill,
  version,
  path,
}: {
  skill: string;
  version: number;
  path: string;
}) {
  const { token } = useAuth();
  const content = useQuery({
    queryKey: ["skill-content", skill, version],
    queryFn: ({ signal }) => getSkillVersionContent(token ?? "", skill, version, signal),
  });
  if (content.isError) return <Alert variant="destructive">{content.error.message}</Alert>;
  if (!content.isSuccess) return <p className="text-xs">Loading...</p>;
  const file = content.data.files.find((candidate) => candidate.path === path);
  if (file === undefined || file.contentBase64 === null)
    return <Alert variant="destructive">The API returned no content for this file.</Alert>;
  const text = decodeText(fromBase64(file.contentBase64));
  if (text === null)
    return <p className="text-xs">Binary file ({formatBytes(file.size)}), not shown.</p>;
  return (
    <pre className="max-h-96 overflow-auto rounded-md border bg-muted p-3 text-xs whitespace-pre-wrap break-words">
      {text}
    </pre>
  );
}

type Panel = "files" | "details";

function VersionRow({
  skill,
  version,
  current,
  pinnedBy,
}: {
  skill: string;
  version: SkillVersion;
  current: boolean;
  pinnedBy: ProfileRef[] | undefined;
}) {
  const { token } = useAuth();
  const [panel, setPanel] = useState<Panel | undefined>(undefined);
  const [open, setOpen] = useState<string | undefined>(undefined);
  const [downloadError, setDownloadError] = useState<string | undefined>(undefined);
  const toggle = (next: Panel): void => setPanel((now) => (now === next ? undefined : next));
  return (
    <Fragment>
      <tr data-testid={`version-${String(version.version)}`}>
        <Td className="whitespace-nowrap">
          v{version.version} {current && <Badge>current</Badge>}
        </Td>
        <Td className="break-words">
          {version.description} {version.disableModelInvocation && <Badge>manual only</Badge>}
        </Td>
        <Td>
          <Time value={version.createdAt} />
          <span className="text-muted-foreground"> by {version.createdBy}</span>
        </Td>
        <Td className="whitespace-nowrap">
          {version.files.length} {version.files.length === 1 ? "file" : "files"},{" "}
          {formatBytes(version.size)}
        </Td>
        <Td>
          {pinnedBy === undefined ? (
            ""
          ) : pinnedBy.length === 0 ? (
            <span className="text-muted-foreground">{"—"}</span>
          ) : (
            <ProfileLinks profiles={pinnedBy} />
          )}
        </Td>
        <Td>
          <span className="flex flex-wrap gap-1">
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={panel === "files"}
              onClick={() => toggle("files")}
            >
              Files
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={panel === "details"}
              onClick={() => toggle("details")}
            >
              Details
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setDownloadError(undefined);
                downloadSkillZip(token ?? "", skill, version.version).catch((error: unknown) =>
                  setDownloadError(error instanceof Error ? error.message : "download failed"),
                );
              }}
            >
              Download zip
            </Button>
          </span>
        </Td>
      </tr>
      {(panel !== undefined || downloadError !== undefined) && (
        <tr>
          <Td colSpan={6} className="bg-muted/40">
            {downloadError !== undefined && <Alert variant="destructive">{downloadError}</Alert>}
            {panel === "details" && (
              <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1">
                <dt className="text-muted-foreground">Hash</dt>
                <dd className="break-all">
                  <code>{version.digest}</code>
                </dd>
                {version.source !== null && (
                  <>
                    <dt className="text-muted-foreground">Source</dt>
                    <dd className="break-all">
                      {version.source.repository} @ {version.source.commit}
                    </dd>
                  </>
                )}
              </dl>
            )}
            {panel === "files" && (
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
                  {version.files.map((file) => (
                    <Fragment key={file.path}>
                      <tr>
                        <Td className="break-all">
                          <span title={`sha256 ${file.sha256}`}>{file.path}</span>{" "}
                          {file.executable && <Badge variant="outline">executable</Badge>}
                        </Td>
                        <Td>{formatBytes(file.size)}</Td>
                        <Td>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setOpen(open === file.path ? undefined : file.path)}
                          >
                            {open === file.path ? "Hide" : "View"}
                          </Button>
                        </Td>
                      </tr>
                      {open === file.path && (
                        <tr>
                          <Td colSpan={3}>
                            <FileContent skill={skill} version={version.version} path={file.path} />
                          </Td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </Table>
            )}
          </Td>
        </tr>
      )}
    </Fragment>
  );
}

export function SkillDetail() {
  const { token } = useAuth();
  const { mode } = useCatalogMode();
  const name = useParams().name ?? "";
  const [older, setOlder] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const skill = useQuery({
    queryKey: ["skill", name],
    queryFn: ({ signal }) => getSkill(token ?? "", name, signal),
  });
  const profiles = useQuery({
    queryKey: ["profile-refs"],
    queryFn: ({ signal }) => listProfileRefs(token ?? "", signal),
  });
  const versions = skill.data?.versions ?? [];
  const shown = versions.filter(
    (version) => older || version.version === skill.data?.currentVersion,
  );
  const hidden = versions.length - shown.length;
  const pinning = profiles.data === undefined ? [] : profilesPinningSkill(profiles.data, name);
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Skill {name}</CardTitle>
          <CardDescription>
            <Link className="underline" to="/skills">
              All skills
            </Link>
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {mode === "readOnly" && <ReadOnlyNote what="Skills" />}
          {mode === "manage" && (
            <div className="flex flex-wrap gap-2">
              <Link to={`/skills/${encodeURIComponent(name)}/publish`}>
                <Button size="sm">Add version</Button>
              </Link>
              {skill.isSuccess && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={deleting}
                  onClick={() => {
                    setDeleting(true);
                  }}
                >
                  Delete skill
                </Button>
              )}
            </div>
          )}
          {mode === "manage" && deleting && skill.isSuccess && (
            <DeleteConfirm
              kind="skill"
              name={name}
              contents="all its versions and files"
              blocked={pinning.length > 0}
              note={
                pinning.length > 0 ? (
                  <Alert variant="destructive">
                    Pinned by <ProfileLinks profiles={pinning} />: publish a version of each without
                    it first. Sessions that still use it also keep it until they are deleted.
                  </Alert>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Sessions that are not deleted and still use it keep it from being deleted.
                  </p>
                )
              }
              run={() => deleteSkill(token ?? "", name, skill.data.currentVersion)}
              onDeleted={() => {
                void queryClient.invalidateQueries({ queryKey: ["skills"] });
                void navigate("/skills");
              }}
              onCancel={() => {
                setDeleting(false);
              }}
            />
          )}
          {skill.isError && <Alert variant="destructive">{skill.error.message}</Alert>}
          {profiles.isError && (
            <Alert variant="destructive">
              Could not load which profiles pin versions: {profiles.error.message}
            </Alert>
          )}
          {skill.isSuccess && (
            <Table>
              <thead>
                <tr>
                  <Th>Version</Th>
                  <Th>Description</Th>
                  <Th>Created</Th>
                  <Th>Files</Th>
                  <Th>Pinned by</Th>
                  <Th>
                    <span className="sr-only">Actions</span>
                  </Th>
                </tr>
              </thead>
              <tbody>
                {shown.map((version) => (
                  <VersionRow
                    key={version.version}
                    skill={name}
                    version={version}
                    current={version.version === skill.data.currentVersion}
                    pinnedBy={
                      profiles.data === undefined
                        ? undefined
                        : profilesPinning(profiles.data, name, version.version)
                    }
                  />
                ))}
              </tbody>
            </Table>
          )}
          {hidden > 0 && (
            <div>
              <Button size="sm" variant="ghost" onClick={() => setOlder(true)}>
                Show {hidden} older {hidden === 1 ? "version" : "versions"}
              </Button>
            </div>
          )}
          {older && versions.length > 1 && (
            <div>
              <Button size="sm" variant="ghost" onClick={() => setOlder(false)}>
                Hide older versions
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
