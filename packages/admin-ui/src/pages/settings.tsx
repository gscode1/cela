import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ReactNode } from "react";
import { useAuth } from "@/auth";
import { ChangeList } from "@/components/change-list";
import { LastChanged } from "@/components/changed";
import { ConflictPanel } from "@/components/conflict-panel";
import type { ConflictView } from "@/components/conflict-panel";
import { AllowedModels, ModelNotice, ModelSelect } from "@/components/model-picker";
import { Time } from "@/components/time";
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
import type { SettingsHistoryEntry, SettingsValues } from "@/lib/api/settings";
import { actorName, isEpoch } from "@/lib/actor";
import { changedNames, diffSettings } from "@/lib/diff";
import { fieldLabel } from "@/lib/field-labels";
import { supportsReasoning } from "@/lib/models";
import { useModelView } from "@/lib/use-models";
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
  emptyLabel,
  onChange,
}: {
  id: string;
  value: string;
  emptyLabel: string;
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
      <option value="">{emptyLabel}</option>
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
  const models = useModelView();
  const profiles = useProfilesQuery();
  const [draft, setDraft] = useDraft<SettingsDraft>("settings");
  const [conflict, setConflict] = useState<ConflictView | undefined>(undefined);
  const [saved, setSaved] = useState(false);
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
      setSaved(true);
      // Settings and their history, and the profile list (it carries the default profile).
      void queryClient.invalidateQueries({ queryKey: keys.settings });
      void queryClient.invalidateQueries({ queryKey: keys.profiles });
    },
    onError: (error) => {
      setSaved(false);
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
    setSaved(false);
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
      : reviewSettingsSave(values, facts, profiles.data.invalid, current.base);
  const storedDefault =
    server === undefined || facts === undefined || profiles.data === undefined
      ? undefined
      : admitDefault(valuesOf(server), facts, profiles.data.invalid);
  const impact = settingsImpact(changes.map((change) => change.field));
  const reasoningSupport = supportsReasoning(models.models, current.form.defaultModel);
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
            {server !== undefined && (
              <>
                {" "}
                <LastChanged by={server.updatedBy} at={server.updatedAt} />.
              </>
            )}
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
            <ModelNotice view={models} />
            <Field id="default-model" label={fieldLabel("defaultModel")}>
              <ModelSelect
                id="default-model"
                value={current.form.defaultModel}
                view={models}
                onChange={(key) => {
                  edit({ defaultModel: key });
                }}
              />
            </Field>
            <AllowedModels
              value={current.form.allowlist}
              defaultModel={current.form.defaultModel.trim()}
              view={models}
              onChange={(next) => {
                edit({ allowlist: next });
              }}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="reasoning" label={fieldLabel("reasoning")}>
                {reasoningSupport === false && current.form.reasoning === "" ? (
                  <p className="text-sm text-muted-foreground">
                    This model has no reasoning levels.
                  </p>
                ) : (
                  <>
                    <ReasoningSelect
                      id="reasoning"
                      value={current.form.reasoning}
                      emptyLabel="model default"
                      onChange={(value) => {
                        edit({ reasoning: value });
                      }}
                    />
                    {reasoningSupport === false && (
                      <p className="text-xs text-muted-foreground">
                        This model has no reasoning levels.
                      </p>
                    )}
                  </>
                )}
              </Field>
              <Field id="max-reasoning" label={fieldLabel("maxReasoning")}>
                <ReasoningSelect
                  id="max-reasoning"
                  value={current.form.maxReasoning}
                  emptyLabel="no limit"
                  onChange={(value) => {
                    edit({ maxReasoning: value });
                  }}
                />
              </Field>
            </div>
            <Field
              id="default-profile"
              label={fieldLabel("defaultProfile")}
              hint="The profile a new session gets when its request names none."
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
              label={fieldLabel("turnBudget")}
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
            <Field
              id="token-budget"
              label={fieldLabel("tokenBudget")}
              hint="Model tokens one session may use in total, checked before each message. Empty: no limit."
            >
              <Input
                id="token-budget"
                inputMode="numeric"
                placeholder="No limit"
                value={current.form.tokenBudgetText}
                onChange={(event) => {
                  edit({ tokenBudgetText: event.target.value });
                }}
              />
            </Field>
            <Field
              id="repo-allowlist"
              label={fieldLabel("repoAllowlist")}
              hint="Repositories a session may clone, one per line: owner/name, owner/* for all of an owner's, or * for every repository the GitHub App can reach."
            >
              <Textarea
                id="repo-allowlist"
                spellCheck={false}
                placeholder="acme/app"
                value={current.form.repoAllowlistText}
                onChange={(event) => {
                  edit({ repoAllowlistText: event.target.value });
                }}
              />
              {values.repoAllowlist.length === 0 && (
                <Alert variant="warning" data-testid="repo-allowlist-empty">
                  Repo sessions are refused while this list is empty.
                </Alert>
              )}
            </Field>
          </form>
        </CardContent>
      </Card>

      {saved && (
        <Alert role="status" data-testid="saved">
          Settings saved.
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
                  Would be refused when a session picks them:{" "}
                  {review.warnings.map((warning) => warning.name).join(", ")}.
                </p>
                <details className="mt-1">
                  <summary className="cursor-pointer text-muted-foreground">details</summary>
                  <ul className="list-disc pl-5">
                    {review.warnings.map((warning) => (
                      <li key={warning.name} className="break-words">
                        {warning.name}: {warning.refused.message}. {warning.refused.fix}
                      </li>
                    ))}
                  </ul>
                </details>
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
            <div className="flex flex-wrap items-center gap-2">
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
              <span className="text-sm text-muted-foreground">Applies to new sessions only.</span>
            </div>
          </CardContent>
        </Card>
      )}

      <SettingsHistory
        entries={history.data ?? []}
        error={history.isError ? history.error.message : undefined}
      />
    </div>
  );
}

const HISTORY_SHOWN = 5;

function SettingsHistory({
  entries,
  error,
}: {
  entries: readonly SettingsHistoryEntry[];
  error: string | undefined;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? entries : entries.slice(0, HISTORY_SHOWN);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent changes</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {error !== undefined && <Alert variant="destructive">{error}</Alert>}
        <ol className="flex flex-col gap-1" aria-label="Settings history">
          {shown.map((entry) => (
            <HistoryRow key={entry.id} entry={entry} />
          ))}
        </ol>
        {!all && entries.length > HISTORY_SHOWN && (
          <div>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setAll(true);
              }}
            >
              Show more
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function HistoryRow({ entry }: { entry: SettingsHistoryEntry }) {
  const [open, setOpen] = useState(false);
  const initial = entry.old === null;
  const changes = diffSettings(entry.old, entry.new);
  return (
    <li className="flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        className="flex flex-wrap items-baseline gap-x-1 text-left text-sm hover:underline"
        onClick={() => {
          setOpen(!open);
        }}
      >
        <span className="font-medium">{actorName(entry.changedBy)}</span>{" "}
        <span>
          {initial
            ? "set the initial values"
            : changes.length === 0
              ? "saved without changes"
              : `changed ${changedNames(changes)}`}
        </span>
        {!isEpoch(entry.changedAt) && (
          <span className="ml-1 text-muted-foreground">
            <Time value={entry.changedAt} />
          </span>
        )}
      </button>
      {open && (
        <div className="pb-2 pl-4">
          <ChangeList changes={changes} initial={initial} />
        </div>
      )}
    </li>
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
  // Only profiles a new session may get are offered; a stale current value stays, marked, so it can be seen and replaced.
  const offered = profiles.filter((profile) => profile.enabledForNew);
  const stale = ((): string | undefined => {
    if (!loaded) return selected;
    if (offered.some((profile) => profile.name === selected)) return undefined;
    if (invalid.includes(selected)) return `${selected} (invalid)`;
    if (profiles.some((profile) => profile.name === selected)) return `${selected} (disabled)`;
    return `${selected} (does not exist)`;
  })();
  return (
    <>
      {stale !== undefined && (
        <option value={selected} disabled={loaded}>
          {stale}
        </option>
      )}
      {offered.map((profile) => (
        <option key={profile.name} value={profile.name}>
          {profile.name}
        </option>
      ))}
    </>
  );
}
