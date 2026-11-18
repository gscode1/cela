import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { useAuth } from "@/auth";
import { LastChanged } from "@/components/changed";
import { DeleteConfirm } from "@/components/delete-confirm";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { isConflict } from "@/lib/api";
import { deleteProfile, putProfile } from "@/lib/api/profiles";
import type { ProfileDefinition, ProfileDetail as ProfileDetailData } from "@/lib/api/profiles";
import { conflictKind } from "@/lib/conflict";
import { applyIntent, describeIntent, hasIntent, intentFromSearch } from "@/lib/profile-links";
import { formFromDefinition } from "@/lib/profile-form";
import { keys, useProfileQuery, useProfilesQuery } from "@/lib/queries";
import { useDraft } from "@/lib/use-draft";
import { UnfilteredBadge } from "@/pages/profiles/pickers";
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
  const [deleting, setDeleting] = useState(false);
  const navigate = useNavigate();
  const [tab, setTab] = useState<"edit" | "versions">("edit");
  const [saved, setSaved] = useState<string | undefined>(savedFromState(location.state));
  const stored = profile.data;
  const [params, setParams] = useSearchParams();
  const applied = useRef(false);

  // `?pinSkill=` and `?addMcp=` from the skill and MCP screens: put the change in this profile's draft once, then drop
  // the parameters so a reload does not add it again. The operator still has to publish.
  useEffect(() => {
    if (stored === undefined || applied.current) return;
    const intent = intentFromSearch(params);
    if (!hasIntent(intent)) return;
    applied.current = true;
    const base = draft ?? seedFor(stored);
    setDraft({ ...base, form: applyIntent(base.form, intent) });
    setSaved(`Draft prepared to ${describeIntent(intent)}. Review it and publish when ready.`);
    setParams({}, { replace: true });
  }, [stored, params, draft, setDraft, setParams]);

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
              {isDefault && <Badge variant="outline">default</Badge>}
              {!stored.enabledForNew && <Badge variant="destructive">disabled</Badge>}
              {stored.definition.networkMode === "direct" && <UnfilteredBadge />}
            </CardTitle>
            <CardDescription>
              <LastChanged by={stored.updatedBy} at={stored.updatedAt} />
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={toggle.isPending || (isDefault && stored.enabledForNew)}
              {...(isDefault && stored.enabledForNew
                ? {
                    title:
                      "This is the default profile. Select another default in Global settings first.",
                  }
                : {})}
              onClick={() => {
                toggle.mutate({ enabled: !stored.enabledForNew, revision: stored.revision });
              }}
            >
              {stored.enabledForNew ? "Disable for new sessions" : "Enable for new sessions"}
            </Button>
            {/* Only a disabled profile that is not the default can go (ADR 0027); the API checks again. */}
            <Button
              variant="outline"
              disabled={stored.enabledForNew || isDefault || deleting}
              title={
                isDefault
                  ? "The default profile cannot be deleted. Select another default in Global settings first."
                  : stored.enabledForNew
                    ? "Disable it for new sessions first."
                    : "Delete this profile and all its versions"
              }
              onClick={() => {
                setDeleting(true);
              }}
            >
              Delete profile
            </Button>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {deleting && (
            <DeleteConfirm
              kind="profile"
              name={name}
              contents="all its versions (sessions keep the copy they started with)"
              run={() => deleteProfile(token ?? "", name, stored.revision)}
              onDeleted={() => {
                setDraft(undefined);
                void queryClient.invalidateQueries({ queryKey: keys.profiles });
                void navigate("/profiles");
              }}
              onCancel={() => {
                setDeleting(false);
              }}
            />
          )}
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
              {/* The API's text names revision numbers; the operator only needs to know it moved on. */}
              <p>Not changed: someone else changed this profile since you opened it.</p>
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
          <div role="tablist" aria-label="Profile views" className="flex gap-4 border-b">
            {(["edit", "versions"] as const).map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                className={`-mb-px border-b-2 px-1 pb-2 text-sm ${tab === id ? "border-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground"}`}
                onClick={() => {
                  setTab(id);
                }}
              >
                {id === "edit" ? "Edit" : "Versions"}
              </button>
            ))}
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
