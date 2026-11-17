import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { useAuth } from "@/auth";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { isConflict } from "@/lib/api";
import { putProfile } from "@/lib/api/profiles";
import type { ProfileDefinition, ProfileDetail as ProfileDetailData } from "@/lib/api/profiles";
import { conflictKind } from "@/lib/conflict";
import { formFromDefinition } from "@/lib/profile-form";
import { keys, useProfileQuery, useProfilesQuery } from "@/lib/queries";
import { useDraft } from "@/lib/use-draft";
import { ProfileEditor } from "@/pages/profiles/editor";
import type { ProfileDraft } from "@/pages/profiles/editor";
import { ProfileVersions } from "@/pages/profiles/versions";

function seedFor(profile: ProfileDetailData): ProfileDraft {
  return {
    name: profile.name,
    form: formFromDefinition(profile.definition),
    base: profile.definition,
    baseRevision: profile.revision,
    baseVersion: profile.currentVersion,
  };
}

/** A string `saved` the editor handed over through the navigation state after a create. */
function savedFromState(state: unknown): string | undefined {
  if (typeof state !== "object" || state === null || !("saved" in state)) return undefined;
  return typeof state.saved === "string" ? state.saved : undefined;
}

export function NewProfile() {
  const navigate = useNavigate();
  const [draft, setDraft] = useDraft<ProfileDraft>("profile:new");
  const current: ProfileDraft = draft ?? {
    name: "",
    form: formFromDefinition({}),
    base: {},
    baseRevision: undefined,
    baseVersion: undefined,
  };
  return (
    <div className="flex flex-col gap-4">
      <Link className="text-sm underline-offset-4 hover:underline" to="/profiles">
        Back to profiles
      </Link>
      <ProfileEditor
        stored={undefined}
        draft={current}
        setDraft={setDraft}
        reload={() => Promise.resolve(undefined)}
        onSaved={(name, message) => {
          void navigate(`/profiles/${name}`, { state: { saved: message } });
        }}
      />
    </div>
  );
}

/** One profile: its state, an editor that publishes versions, and the stored versions with their diffs. */
export function ProfileScreen() {
  const { name = "" } = useParams();
  return <ProfileScreenFor key={name} name={name} />;
}

function ProfileScreenFor({ name }: { name: string }) {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  const location = useLocation();
  const profile = useProfileQuery(name);
  const list = useProfilesQuery();
  const [draft, setDraft] = useDraft<ProfileDraft>(`profile:${name}`);
  const [tab, setTab] = useState<"edit" | "versions">("edit");
  const [saved, setSaved] = useState<string | undefined>(savedFromState(location.state));
  const stored = profile.data;

  const toggle = useMutation({
    mutationFn: (input: { enabled: boolean; revision: number }) =>
      putProfile(token ?? "", name, {
        enabledForNew: input.enabled,
        expectedRevision: input.revision,
      }),
    onSuccess: (result) => {
      queryClient.setQueryData<ProfileDetailData>(keys.profile(name), (old) =>
        old === undefined ? old : { ...old, ...result },
      );
      // An enable or disable adds a revision but no version. A draft of the same version stays valid on top of it.
      if (draft !== undefined && draft.baseVersion === result.currentVersion)
        setDraft({ ...draft, baseRevision: result.revision });
      setSaved(
        result.enabledForNew
          ? `${name} is enabled for new sessions.`
          : `${name} is disabled for new sessions.`,
      );
      void queryClient.invalidateQueries({ queryKey: keys.profiles });
    },
    onError: () => {
      setSaved(undefined);
    },
  });

  if (stored === undefined) {
    const invalid = list.data?.invalid.find((entry) => entry.name === name);
    return (
      <Card>
        <CardHeader>
          <CardTitle>{name}</CardTitle>
          <CardDescription>{profile.isError ? profile.error.message : "Loading"}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {invalid !== undefined && (
            <Alert variant="destructive" data-testid="invalid-profile">
              <Badge variant="destructive">invalid</Badge>{" "}
              <span className="break-words">{invalid.message}</span>
            </Alert>
          )}
          <Link className="text-sm underline-offset-4 hover:underline" to="/profiles">
            Back to profiles
          </Link>
        </CardContent>
      </Card>
    );
  }

  const isDefault = list.data?.defaultProfile === name;
  const current = draft ?? seedFor(stored);
  const toggleConflict = toggle.isError && isConflict(toggle.error) ? toggle.error : undefined;
  return (
    <div className="flex flex-col gap-4">
      <Link className="text-sm underline-offset-4 hover:underline" to="/profiles">
        Back to profiles
      </Link>
      <Card>
        <CardHeader className="flex-row flex-wrap items-start justify-between gap-4">
          <div className="flex flex-col gap-1.5">
            <CardTitle className="flex flex-wrap items-center gap-2">
              {name}
              <Badge variant="outline">v{stored.currentVersion}</Badge>
              <Badge variant={stored.enabledForNew ? "secondary" : "destructive"}>
                {stored.enabledForNew ? "enabled" : "disabled"}
              </Badge>
              {isDefault && <Badge variant="outline">default</Badge>}
            </CardTitle>
            <CardDescription>
              Last change by {stored.updatedBy} at {stored.updatedAt}. Revision {stored.revision}.
            </CardDescription>
          </div>
          <Button
            variant="outline"
            disabled={toggle.isPending}
            onClick={() => {
              toggle.mutate({ enabled: !stored.enabledForNew, revision: stored.revision });
            }}
          >
            {stored.enabledForNew ? "Disable for new sessions" : "Enable for new sessions"}
          </Button>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {isDefault && stored.enabledForNew && (
            <p className="text-sm text-muted-foreground">
              This is the default profile. To disable it, select another enabled profile as the
              default first.
            </p>
          )}
          <p className="text-sm text-muted-foreground">
            Enabling or disabling decides whether new sessions may choose the profile. It adds no
            version and never changes a session that exists.
          </p>
          {toggleConflict !== undefined && conflictKind(toggleConflict) === "default-profile" && (
            <Alert variant="warning" data-testid="toggle-conflict">
              <p className="break-words">{toggleConflict.message}</p>
              <p>
                Fix: select another enabled profile as the default in{" "}
                <Link className="underline" to="/settings">
                  Global settings
                </Link>
                , then disable this one.
              </p>
            </Alert>
          )}
          {toggleConflict !== undefined && conflictKind(toggleConflict) === "stale" && (
            <Alert variant="warning" data-testid="toggle-conflict">
              <p className="break-words">{toggleConflict.message}</p>
              <Button
                className="mt-2"
                size="sm"
                variant="outline"
                onClick={() => {
                  void profile.refetch();
                  toggle.reset();
                }}
              >
                Reload
              </Button>
            </Alert>
          )}
          {toggle.isError && !isConflict(toggle.error) && (
            <Alert variant="destructive">{toggle.error.message}</Alert>
          )}
          {saved !== undefined && (
            <Alert role="status" data-testid="saved">
              {saved}
            </Alert>
          )}
          <div role="tablist" aria-label="Profile views" className="flex gap-2">
            <Button
              role="tab"
              aria-selected={tab === "edit"}
              variant={tab === "edit" ? "default" : "outline"}
              size="sm"
              onClick={() => {
                setTab("edit");
              }}
            >
              Edit
            </Button>
            <Button
              role="tab"
              aria-selected={tab === "versions"}
              variant={tab === "versions" ? "default" : "outline"}
              size="sm"
              onClick={() => {
                setTab("versions");
              }}
            >
              Versions
            </Button>
          </div>
        </CardContent>
      </Card>
      {tab === "edit" ? (
        <ProfileEditor
          stored={stored}
          draft={current}
          setDraft={setDraft}
          reload={async () => (await profile.refetch()).data}
          onSaved={(_name, message) => {
            setSaved(message);
          }}
        />
      ) : (
        <ProfileVersions
          profile={stored}
          onUseAsDraft={(definition: ProfileDefinition) => {
            setDraft({ ...seedFor(stored), form: formFromDefinition(definition) });
            setTab("edit");
          }}
        />
      )}
    </div>
  );
}
