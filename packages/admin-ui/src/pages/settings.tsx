import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ReactNode } from "react";
import { useAuth } from "@/auth";
import { ChangeList } from "@/components/change-list";
import { ConflictPanel } from "@/components/conflict-panel";
import type { ConflictView } from "@/components/conflict-panel";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { admitDefault, reviewSettingsSave } from "@/lib/admission";
import type { ProfileFacts } from "@/lib/admission";
import { isConflict } from "@/lib/api";
import type { AdminSettings } from "@/lib/api";
import { REASONING_LEVELS, putSettings, valuesOf } from "@/lib/api/settings";
import type { SettingsValues } from "@/lib/api/settings";
import { diffSettings } from "@/lib/diff";
import { settingsImpact } from "@/lib/impact";
import { keys, useProfilesQuery, useSettingsHistoryQuery, useSettingsQuery } from "@/lib/queries";
import {
  formFromValues,
  sameSettings,
  settingsProblems,
  valuesFromForm,
} from "@/lib/settings-form";
import type { SettingsForm } from "@/lib/settings-form";
import { useDraft } from "@/lib/use-draft";

/** The edit in progress: the form, and the server version it started from (its revision goes back as `expectedRevision`). */
interface SettingsDraft {
  form: SettingsForm;
  base: SettingsValues;
  baseRevision: number;
}

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint !== undefined && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function ReasoningSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (value: SettingsForm["reasoning"]) => void;
}) {
  return (
    <Select
      id={id}
      value={value}
      onChange={(event) => {
        onChange(REASONING_LEVELS.find((level) => level === event.target.value) ?? "");
      }}
    >
      <option value="">not set</option>
      {REASONING_LEVELS.map((level) => (
        <option key={level} value={level}>
          {level}
        </option>
      ))}
    </Select>
  );
}

/** Global settings: edit, review the change against the profiles, save with the revision the edit started from. */
export function GlobalSettings() {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  const settings = useSettingsQuery();
  const history = useSettingsHistoryQuery();
  const profiles = useProfilesQuery();
  const [draft, setDraft] = useDraft<SettingsDraft>("settings");
  const [conflict, setConflict] = useState<ConflictView | undefined>(undefined);
  const [saved, setSaved] = useState<string[] | undefined>(undefined);
  const [reloading, setReloading] = useState(false);

  const server = settings.data;
  const current: SettingsDraft | undefined =
    draft ??
    (server === undefined
      ? undefined
      : {
          form: formFromValues(valuesOf(server)),
          base: valuesOf(server),
          baseRevision: server.revision,
        });

  const save = useMutation({
    mutationFn: (input: { values: SettingsValues; revision: number }) =>
      putSettings(token ?? "", input.values, input.revision),
    onSuccess: (stored: AdminSettings) => {
      queryClient.setQueryData(keys.settings, stored);
      setDraft(undefined);
      setConflict(undefined);
      const changed =
        current === undefined
          ? []
          : diffSettings(current.base, valuesOf(stored)).map((c) => c.field);
      setSaved(settingsImpact(changed));
      // Settings and their history, and the profile list (it carries the default profile).
      void queryClient.invalidateQueries({ queryKey: keys.settings });
      void queryClient.invalidateQueries({ queryKey: keys.profiles });
    },
    onError: (error) => {
      setSaved(undefined);
      if (isConflict(error)) setConflict({ message: error.message });
    },
  });

  if (current === undefined) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Global settings</CardTitle>
          <CardDescription>{settings.isError ? settings.error.message : "Loading"}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const edit = (patch: Partial<SettingsForm>): void => {
    setSaved(undefined);
    setDraft({ ...current, form: { ...current.form, ...patch } });
  };
  const values = valuesFromForm(current.form);
  const changes = diffSettings(current.base, values);
  const dirty = !sameSettings(values, current.base);
  const problems = settingsProblems(values);
  const facts: ProfileFacts[] | undefined = profiles.data?.profiles;
  const review =
    facts === undefined || profiles.data === undefined
      ? undefined
      : reviewSettingsSave(values, facts, profiles.data.invalid);
  const storedDefault =
    server === undefined || facts === undefined || profiles.data === undefined
      ? undefined
      : admitDefault(valuesOf(server), facts, profiles.data.invalid);
  const impact = settingsImpact(changes.map((change) => change.field));
  const blocked = problems.length > 0 || review?.blocking !== undefined || review === undefined;

  const reload = (): void => {
    setReloading(true);
    void settings.refetch().then((result) => {
      setReloading(false);
      const fresh = result.data;
      if (fresh === undefined || conflict === undefined) return;
      setConflict({
        ...conflict,
        current: {
          revision: fresh.revision,
          updatedBy: fresh.updatedBy,
          updatedAt: fresh.updatedAt,
        },
        changes: diffSettings(valuesOf(fresh), values),
      });
    });
  };
  const rebase = (): void => {
    if (server === undefined) return;
    setDraft({ ...current, base: valuesOf(server), baseRevision: server.revision });
    setConflict(undefined);
  };
  const discard = (): void => {
    setDraft(undefined);
    setConflict(undefined);
  };

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Global settings</CardTitle>
          <CardDescription>
            What a new session gets when its request and its profile say nothing.
            {server !== undefined &&
              ` Revision ${String(server.revision)}, last changed by ${server.updatedBy} at ${server.updatedAt}.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {settings.isError && <Alert variant="destructive">{settings.error.message}</Alert>}
          {storedDefault !== undefined && !storedDefault.ok && (
            <Alert variant="warning" data-testid="default-problem">
              <p className="font-medium">New sessions without a profile are refused right now.</p>
              <p className="break-words">{storedDefault.message}</p>
              <p>{storedDefault.fix}</p>
            </Alert>
          )}
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
            }}
          >
            <Field id="default-model" label="Default model" hint="provider/model; always allowed.">
              <Input
                id="default-model"
                value={current.form.defaultModel}
                onChange={(event) => {
                  edit({ defaultModel: event.target.value });
                }}
              />
            </Field>
            <Field
              id="allowlist"
              label="Allowlist"
              hint="One provider/model per line. The default model is always included."
            >
              <Textarea
                id="allowlist"
                value={current.form.allowlistText}
                onChange={(event) => {
                  edit({ allowlistText: event.target.value });
                }}
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="reasoning" label="Reasoning" hint="Clearing it sends null.">
                <ReasoningSelect
                  id="reasoning"
                  value={current.form.reasoning}
                  onChange={(value) => {
                    edit({ reasoning: value });
                  }}
                />
              </Field>
              <Field
                id="max-reasoning"
                label="Max reasoning"
                hint="Highest effort a request may ask for."
              >
                <ReasoningSelect
                  id="max-reasoning"
                  value={current.form.maxReasoning}
                  onChange={(value) => {
                    edit({ maxReasoning: value });
                  }}
                />
              </Field>
            </div>
            <Field
              id="default-profile"
              label="Default profile"
              hint="The profile a new session gets when its request names none. It must exist and be enabled."
            >
              <Select
                id="default-profile"
                value={current.form.defaultProfile}
                onChange={(event) => {
                  edit({ defaultProfile: event.target.value });
                }}
              >
                <DefaultProfileOptions
                  selected={current.form.defaultProfile}
                  profiles={profiles.data?.profiles ?? []}
                  invalid={profiles.data?.invalid.map((entry) => entry.name) ?? []}
                  loaded={profiles.data !== undefined}
                />
              </Select>
            </Field>
            <Field
              id="turn-budget"
              label="Turn budget"
              hint="Model turns one session may use in total, 1 to 1000000."
            >
              <Input
                id="turn-budget"
                inputMode="numeric"
                value={current.form.turnBudgetText}
                onChange={(event) => {
                  edit({ turnBudgetText: event.target.value });
                }}
              />
            </Field>
          </form>
        </CardContent>
      </Card>

      {saved !== undefined && (
        <Alert role="status" data-testid="saved">
          <p className="font-medium">Settings saved.</p>
          {saved.map((note) => (
            <p key={note}>{note}</p>
          ))}
        </Alert>
      )}

      {conflict !== undefined && (
        <ConflictPanel
          what="the settings"
          conflict={conflict}
          busy={reloading || save.isPending}
          onReload={reload}
          onRebase={rebase}
          onDiscard={discard}
        />
      )}

      {dirty && (
        <Card role="region" aria-label="Review before saving">
          <CardHeader>
            <CardTitle>Review before saving</CardTitle>
            <CardDescription>Previous values are revision {current.baseRevision}.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <ChangeList changes={changes} />
            {problems.map((problem) => (
              <Alert key={problem} variant="destructive">
                {problem}
              </Alert>
            ))}
            {review?.blocking !== undefined && (
              <Alert variant="destructive" data-testid="blocking">
                <p className="font-medium">Correct this before saving.</p>
                <p className="break-words">{review.blocking.message}</p>
                <p>{review.blocking.fix}</p>
              </Alert>
            )}
            {review !== undefined && review.warnings.length > 0 && (
              <Alert variant="warning" data-testid="warnings">
                <p className="font-medium">
                  Other enabled profiles would be refused when a session picks them.
                </p>
                <ul className="list-disc pl-5">
                  {review.warnings.map((warning) => (
                    <li key={warning.name} className="break-words">
                      {warning.name}: {warning.refused.message}. {warning.refused.fix}
                    </li>
                  ))}
                </ul>
              </Alert>
            )}
            {impact.map((note) => (
              <p key={note} className="text-sm text-muted-foreground">
                {note}
              </p>
            ))}
            {save.isError && !isConflict(save.error) && (
              <Alert variant="destructive">{save.error.message}</Alert>
            )}
            <div className="flex gap-2">
              <Button
                disabled={blocked || save.isPending}
                onClick={() => {
                  save.mutate({ values, revision: current.baseRevision });
                }}
              >
                {save.isPending ? "Saving" : "Save settings"}
              </Button>
              <Button variant="ghost" disabled={save.isPending} onClick={discard}>
                Discard changes
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Recent changes</CardTitle>
          <CardDescription>Newest first, at most 20 entries.</CardDescription>
        </CardHeader>
        <CardContent>
          {history.isError && <Alert variant="destructive">{history.error.message}</Alert>}
          <ol className="flex flex-col gap-4" aria-label="Settings history">
            {(history.data ?? []).map((entry) => (
              <li key={entry.id} className="flex flex-col gap-1">
                <p className="text-sm">
                  <span className="font-medium">{entry.changedBy}</span>{" "}
                  <span className="text-muted-foreground">{entry.changedAt}</span>
                  {entry.old === null && " (initial values)"}
                </p>
                <ChangeList changes={diffSettings(entry.old, entry.new)} />
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}

function DefaultProfileOptions({
  selected,
  profiles,
  invalid,
  loaded,
}: {
  selected: string;
  profiles: { name: string; enabledForNew: boolean }[];
  invalid: string[];
  loaded: boolean;
}) {
  const known = new Set([...profiles.map((profile) => profile.name), ...invalid]);
  return (
    <>
      {loaded && !known.has(selected) && (
        <option value={selected}>{selected} (does not exist)</option>
      )}
      {!loaded && <option value={selected}>{selected}</option>}
      {profiles.map((profile) => (
        <option key={profile.name} value={profile.name} disabled={!profile.enabledForNew}>
          {profile.enabledForNew ? profile.name : `${profile.name} (disabled)`}
        </option>
      ))}
      {invalid.map((name) => (
        <option key={name} value={name} disabled>
          {name} (invalid)
        </option>
      ))}
    </>
  );
}
