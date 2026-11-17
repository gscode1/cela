import { useState } from "react";
import { ChangeList } from "@/components/change-list";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import type { ProfileDefinition, ProfileDetail } from "@/lib/api/profiles";
import { diffDefinitions } from "@/lib/diff";

/** The stored versions, newest first, and a diff between any two of them. */
export function ProfileVersions({
  profile,
  onUseAsDraft,
}: {
  profile: ProfileDetail;
  /** Starts a draft from an older definition: saving it publishes a new version. */
  onUseAsDraft: (definition: ProfileDefinition) => void;
}) {
  const versions = profile.versions;
  const newest = versions[0]?.version;
  const previous = versions[1]?.version ?? newest;
  const [from, setFrom] = useState<string | undefined>(undefined);
  const [to, setTo] = useState<string | undefined>(undefined);
  const fromVersion = versions.find((v) => String(v.version) === (from ?? String(previous)));
  const toVersion = versions.find((v) => String(v.version) === (to ?? String(newest)));
  const options = versions.map((version) => (
    <option key={version.version} value={String(version.version)}>
      v{version.version}
    </option>
  ));
  return (
    <Card>
      <CardHeader>
        <CardTitle>Versions</CardTitle>
        <CardDescription>
          Stored definitions, newest first. A diff compares what was stored; an older definition is
          previewed with the current settings.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="diff-from">From</Label>
            <Select
              id="diff-from"
              value={fromVersion === undefined ? "" : String(fromVersion.version)}
              onChange={(event) => {
                setFrom(event.target.value);
              }}
            >
              {options}
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="diff-to">To</Label>
            <Select
              id="diff-to"
              value={toVersion === undefined ? "" : String(toVersion.version)}
              onChange={(event) => {
                setTo(event.target.value);
              }}
            >
              {options}
            </Select>
          </div>
        </div>
        {fromVersion !== undefined && toVersion !== undefined && (
          <div aria-label="Version diff">
            <ChangeList
              changes={diffDefinitions(fromVersion.definition, toVersion.definition)}
              beforeLabel={`v${String(fromVersion.version)}`}
              afterLabel={`v${String(toVersion.version)}`}
            />
          </div>
        )}
        <ol className="flex flex-col gap-3" aria-label="Version list">
          {versions.map((version) => (
            <li key={version.version} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">v{version.version}</span>
              {version.version === profile.currentVersion && (
                <Badge variant="outline">current</Badge>
              )}
              <span>{version.createdBy}</span>
              <span className="text-muted-foreground">{version.createdAt}</span>
              {version.invalid !== undefined ? (
                <Badge variant="destructive">invalid: {version.invalid}</Badge>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    onUseAsDraft(version.definition);
                  }}
                >
                  Use v{version.version} as draft
                </Button>
              )}
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}
