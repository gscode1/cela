import { useQuery } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { Link, useParams } from "react-router";
import { useAuth } from "@/auth";
import { ReadOnlyNote } from "@/components/read-only-note";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, Td, Th } from "@/components/ui/table";
import { listProfileRefs, profilesPinning } from "@/lib/api/profile-refs";
import { downloadSkillZip, getSkill, getSkillVersionContent } from "@/lib/api/skills";
import type { SkillVersion } from "@/lib/api/skills";
import { decodeText, formatBytes, fromBase64 } from "@/lib/skills/bundle";
import { shortHash } from "@/lib/format";
import { useCatalogMode } from "@/lib/use-catalog-mode";

/** A file's content, fetched when asked for: the text as text, a binary by its digest only. */
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
    return (
      <p className="text-xs">
        Binary file, {formatBytes(file.size)}. Not shown; compare its sha256:{" "}
        <code className="break-all">{file.sha256}</code>
      </p>
    );
  return (
    <pre className="max-h-96 overflow-auto rounded-md border bg-muted p-3 text-xs whitespace-pre-wrap break-words">
      {text}
    </pre>
  );
}

function VersionCard({
  skill,
  version,
  current,
  pinnedBy,
}: {
  skill: string;
  version: SkillVersion;
  current: boolean;
  pinnedBy: { name: string; enabledForNew: boolean }[] | undefined;
}) {
  const { token } = useAuth();
  const [showFiles, setShowFiles] = useState(false);
  const [open, setOpen] = useState<string | undefined>(undefined);
  const [downloadError, setDownloadError] = useState<string | undefined>(undefined);
  return (
    <Card data-testid={`version-${String(version.version)}`}>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle>v{version.version}</CardTitle>
          {current && <Badge>current</Badge>}
          {version.disableModelInvocation && (
            <Badge variant="warning">model invocation disabled</Badge>
          )}
        </div>
        <CardDescription className="break-words">{version.description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Digest</dt>
          <dd className="break-all">
            <code>{version.digest}</code>
          </dd>
          <dt className="text-muted-foreground">Created</dt>
          <dd>
            {version.createdAt} by {version.createdBy}
          </dd>
          <dt className="text-muted-foreground">Size</dt>
          <dd>
            {formatBytes(version.size)} in {version.files.length} files
          </dd>
          {version.source !== null && (
            <>
              <dt className="text-muted-foreground">Source</dt>
              <dd className="break-all">
                {version.source.repository} @ {version.source.commit}
              </dd>
            </>
          )}
          <dt className="text-muted-foreground">Pinned by</dt>
          <dd>
            {pinnedBy === undefined ? (
              "loading"
            ) : pinnedBy.length === 0 ? (
              "no profile"
            ) : (
              <span className="inline-flex flex-wrap gap-x-2">
                {pinnedBy.map((profile) => (
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
            )}
          </dd>
        </dl>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => setShowFiles((shown) => !shown)}>
            {showFiles ? "Hide files" : "Show files"}
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
        </div>
        {downloadError !== undefined && <Alert variant="destructive">{downloadError}</Alert>}
        {showFiles && (
          <Table>
            <thead>
              <tr>
                <Th>Path</Th>
                <Th>Size</Th>
                <Th>sha256</Th>
                <Th>Executable</Th>
                <Th>Content</Th>
              </tr>
            </thead>
            <tbody>
              {version.files.map((file) => (
                <Fragment key={file.path}>
                  <tr>
                    <Td className="break-all">{file.path}</Td>
                    <Td>{formatBytes(file.size)}</Td>
                    <Td>
                      <code title={file.sha256}>{shortHash(file.sha256)}</code>
                    </Td>
                    <Td>{file.executable ? <Badge variant="warning">executable</Badge> : "no"}</Td>
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
                      <Td colSpan={5}>
                        <FileContent skill={skill} version={version.version} path={file.path} />
                      </Td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

export function SkillDetail() {
  const { token } = useAuth();
  const { mode } = useCatalogMode();
  const name = useParams().name ?? "";
  const skill = useQuery({
    queryKey: ["skill", name],
    queryFn: ({ signal }) => getSkill(token ?? "", name, signal),
  });
  const profiles = useQuery({
    queryKey: ["profile-refs"],
    queryFn: ({ signal }) => listProfileRefs(token ?? "", signal),
  });
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
            <div>
              <Link to={`/skills/${encodeURIComponent(name)}/publish`}>
                <Button size="sm">Publish a new version</Button>
              </Link>
            </div>
          )}
          {skill.isError && <Alert variant="destructive">{skill.error.message}</Alert>}
          {profiles.isError && (
            <Alert variant="destructive">
              Could not load which profiles pin versions: {profiles.error.message}
            </Alert>
          )}
        </CardContent>
      </Card>
      {skill.data?.versions.map((version) => (
        <VersionCard
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
    </div>
  );
}
