import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useAuth } from "@/auth";
import { ChangeList } from "@/components/change-list";
import { ConflictPanel } from "@/components/conflict-panel";
import type { ConflictView } from "@/components/conflict-panel";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { effectiveAllowlist, reviewProfileSave } from "@/lib/admission";
import { isConflict } from "@/lib/api";
import { putProfile } from "@/lib/api/profiles";
import type { ProfileDefinition, ProfileDetail } from "@/lib/api/profiles";
import { REASONING_LEVELS, valuesOf } from "@/lib/api/settings";
import { diffDefinitions } from "@/lib/diff";
import { profileImpact } from "@/lib/impact";
import {
  PROFILE_NAME,
  definitionFromForm,
  definitionProblems,
  executableSkillsWithoutBash,
  readProblems,
  referenceProblems,
  withoutBrokenReferences,
} from "@/lib/profile-form";
import type { ProfileForm } from "@/lib/profile-form";
import {
  keys,
  useMcpPickerQuery,
  useProfilesQuery,
  useSettingsQuery,
  useSkillPickerQuery,
  useToolsQuery,
} from "@/lib/queries";
import { Fieldset, McpPicker, SkillPicker, ToolList } from "@/pages/profiles/pickers";
import { AdmissionPreview } from "@/pages/profiles/preview";

/**
 * The edit in progress. `base` is the stored definition the form started from and `baseRevision` the revision that goes
 * back as `expectedRevision`; a create has neither.
 */
export interface ProfileDraft {
  name: string;
  form: ProfileForm;
  base: ProfileDefinition;
  baseRevision: number | undefined;
  baseVersion: number | undefined;
}

export function ProfileEditor({
  stored,
  draft,
  setDraft,
  reload,
  onSaved,
}: {
  /** The profile being edited; undefined while creating. */
  stored: ProfileDetail | undefined;
  draft: ProfileDraft;
  setDraft: (draft: ProfileDraft | undefined) => void;
  /** Fetches the profile again for "reload and compare". */
  reload: () => Promise<ProfileDetail | undefined>;
  onSaved: (name: string, message: string) => void;
}) {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  const settings = useSettingsQuery();
  const profiles = useProfilesQuery();
  const tools = useToolsQuery();
  const mcp = useMcpPickerQuery();
  const skills = useSkillPickerQuery();
  const [conflict, setConflict] = useState<ConflictView | undefined>(undefined);
  const [reloading, setReloading] = useState(false);
  const creating = stored === undefined;
  const { form, base, name } = draft;

  const definition = definitionFromForm(form, base);
  const changes = diffDefinitions(base, definition);
  const nameProblem = !creating
    ? undefined
    : !PROFILE_NAME.test(name)
      ? "Names start with a letter and use lowercase letters, digits and hyphens, at most 32 characters."
      : profiles.data?.profiles.some((profile) => profile.name === name) === true ||
          profiles.data?.invalid.some((profile) => profile.name === name) === true
        ? `A profile named "${name}" exists: saving would publish a new version of it.`
        : undefined;
  const problems = definitionProblems(definition);
  const refs =
    tools.data === undefined || mcp.data === undefined
      ? undefined
      : referenceProblems(definition, { tools: tools.data.tools, mcpServers: mcp.data });
  const broken =
    refs !== undefined && (refs.unknownTools.length > 0 || refs.missingServers.length > 0);
  const needRead = readProblems(definition);
  const noBash = executableSkillsWithoutBash(definition, skills.data ?? []);
  const settingsValues = settings.data === undefined ? undefined : valuesOf(settings.data);
  const review =
    settingsValues === undefined
      ? undefined
      : reviewProfileSave(settingsValues, {
          name,
          enabledForNew: stored?.enabledForNew ?? true,
          definition,
          currentVersion: (stored?.currentVersion ?? 0) + 1,
        });
  const impact = profileImpact(changes.map((change) => change.field));
  const dirty = creating || changes.length > 0;
  const canSave =
    dirty &&
    nameProblem === undefined &&
    problems.length === 0 &&
    !broken &&
    review !== undefined &&
    review.blocking === undefined;

  const edit = (patch: Partial<ProfileForm>): void => {
    setDraft({ ...draft, form: { ...form, ...patch } });
  };

  const save = useMutation({
    mutationFn: () =>
      putProfile(token ?? "", name, {
        definition,
        ...(draft.baseRevision === undefined ? {} : { expectedRevision: draft.baseRevision }),
      }),
    onSuccess: (result) => {
      setDraft(undefined);
      setConflict(undefined);
      void queryClient.invalidateQueries({ queryKey: keys.profiles });
      onSaved(
        result.name,
        result.versionCreated
          ? `Published version ${String(result.currentVersion)} of ${result.name}.`
          : `${result.name} already has this definition: nothing was written.`,
      );
    },
    onError: (error) => {
      if (isConflict(error)) setConflict({ message: error.message });
    },
  });

  const reloadAndCompare = (): void => {
    setReloading(true);
    void reload().then((fresh) => {
      setReloading(false);
      if (fresh === undefined || conflict === undefined) return;
      setConflict({
        ...conflict,
        current: {
          revision: fresh.revision,
          updatedBy: fresh.updatedBy,
          updatedAt: fresh.updatedAt,
        },
        changes: diffDefinitions(fresh.definition, definition),
      });
    });
  };
  const rebase = (): void => {
    const fresh = queryClient.getQueryData<ProfileDetail>(keys.profile(name));
    if (fresh === undefined) return;
    setDraft({
      ...draft,
      base: fresh.definition,
      baseRevision: fresh.revision,
      baseVersion: fresh.currentVersion,
    });
    setConflict(undefined);
  };

  const modelOptions = settingsValues === undefined ? [] : effectiveAllowlist(settingsValues);
  const installed = tools.data?.tools ?? [];
  const enabledTools = form.allTools ? installed : form.tools;
  const modelToolsOffered = installed.filter((tool) => enabledTools.includes(tool));

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{creating ? "New profile" : `Edit ${name}`}</CardTitle>
          <CardDescription>
            {creating
              ? "A profile names what a session gets. Creating it publishes version 1."
              : `Changing the definition publishes version ${String(stored.currentVersion + 1)}. Versions never change.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {tools.isError && <Alert variant="destructive">{tools.error.message}</Alert>}
          {creating && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="profile-name">Name</Label>
              <Input
                id="profile-name"
                value={name}
                onChange={(event) => {
                  setDraft({ ...draft, name: event.target.value });
                }}
              />
              {nameProblem !== undefined && (
                <p className="text-xs text-muted-foreground">{nameProblem}</p>
              )}
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="instructions">Instructions</Label>
            <Textarea
              id="instructions"
              className="min-h-32"
              value={form.instructions}
              onChange={(event) => {
                edit({ instructions: event.target.value });
              }}
            />
            <p className="text-xs text-muted-foreground">
              Added to the system prompt. Empty leaves the field out. {form.instructions.length} of
              8000 characters.
            </p>
          </div>
          <ToolList
            idPrefix="tools"
            legend="Tools"
            hint="Coding tools enabled for the session. All leaves the field out; a selection is an explicit list, and an empty selection means no tools."
            all={form.allTools}
            selected={form.tools}
            offered={installed}
            installed={installed}
            onChange={(all, selected) => {
              // modelTools is a subset of tools: dropping an enabled tool drops it from the offered list too.
              edit({
                allTools: all,
                tools: selected,
                modelTools: all
                  ? form.modelTools
                  : form.modelTools.filter((tool) => selected.includes(tool)),
              });
            }}
          />
          <ToolList
            idPrefix="model-tools"
            legend="Model tools"
            hint="Of the enabled tools, the ones offered to the model. All leaves the field out."
            all={form.allModelTools}
            selected={form.modelTools}
            offered={modelToolsOffered}
            installed={installed}
            onChange={(all, selected) => {
              edit({ allModelTools: all, modelTools: selected });
            }}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="profile-model">Model</Label>
              <Select
                id="profile-model"
                value={form.defaultModel}
                onChange={(event) => {
                  edit({ defaultModel: event.target.value });
                }}
              >
                <option value="">
                  global default
                  {settingsValues === undefined ? "" : ` (${settingsValues.defaultModel})`}
                </option>
                {form.defaultModel !== "" && !modelOptions.includes(form.defaultModel) && (
                  <option value={form.defaultModel}>
                    {form.defaultModel} (not on the allowlist)
                  </option>
                )}
                {modelOptions.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </Select>
              <p className="text-xs text-muted-foreground">
                Used when the request names no model. Choosing the global default leaves the field
                out.
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="profile-reasoning">Reasoning</Label>
              <Select
                id="profile-reasoning"
                value={form.reasoning}
                onChange={(event) => {
                  edit({
                    reasoning: REASONING_LEVELS.find((level) => level === event.target.value) ?? "",
                  });
                }}
              >
                <option value="">global default</option>
                {REASONING_LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </Select>
              <p className="text-xs text-muted-foreground">
                off is an override that turns reasoning off. The global default leaves the field
                out.
              </p>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="profile-turn-budget">Turn budget</Label>
            <Input
              id="profile-turn-budget"
              inputMode="numeric"
              placeholder={
                settingsValues === undefined ? "" : `global: ${String(settingsValues.turnBudget)}`
              }
              value={form.turnBudget}
              onChange={(event) => {
                edit({ turnBudget: event.target.value });
              }}
            />
            <p className="text-xs text-muted-foreground">
              Empty leaves the field out: sessions use the global budget.
            </p>
          </div>
          <McpPicker
            selected={form.mcpServers}
            catalog={mcp.data}
            onChange={(selected) => {
              edit({ mcpServers: selected });
            }}
          />
          <SkillPicker
            pins={form.skills}
            catalog={skills.data}
            onChange={(pins) => {
              edit({ skills: pins });
            }}
          />
          <Fieldset legend="Repository" hint="Both are ignored for a session without a repository.">
            <div className="flex items-center gap-2">
              <Checkbox
                id="repo-skills"
                checked={form.repoSkills}
                onChange={(event) => {
                  edit({ repoSkills: event.target.checked });
                }}
              />
              <Label htmlFor="repo-skills">Load skills from the repository checkout</Label>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="repo-context"
                checked={form.repoContext}
                onChange={(event) => {
                  edit({ repoContext: event.target.checked });
                }}
              />
              <Label htmlFor="repo-context">
                Load the repository&apos;s AGENTS.md or CLAUDE.md as instructions
              </Label>
            </div>
          </Fieldset>
        </CardContent>
      </Card>

      {conflict !== undefined && (
        <ConflictPanel
          what="this profile"
          conflict={conflict}
          busy={reloading || save.isPending}
          onReload={reloadAndCompare}
          onRebase={rebase}
          onDiscard={() => {
            setDraft(undefined);
            setConflict(undefined);
          }}
        />
      )}

      <Card>
        <CardHeader>
          <CardTitle>Review before saving</CardTitle>
          <CardDescription>
            {creating
              ? "A new profile."
              : `Changes against version ${String(stored.currentVersion)}.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {!creating && <ChangeList changes={changes} />}
          {creating && <ChangeList changes={diffDefinitions({}, definition)} />}
          {problems.map((problem) => (
            <Alert key={problem} variant="destructive">
              {problem}
            </Alert>
          ))}
          {needRead.length > 0 && (
            <Alert variant="warning" data-testid="read-dependency">
              <p className="font-medium">Skills are loaded by reading their SKILL.md.</p>
              <p>
                Add read to the explicit tool list that lacks it, or remove the skills and
                repository skills. The console does not change tool access for you.
              </p>
            </Alert>
          )}
          {noBash.length > 0 && (
            <Alert variant="warning" data-testid="bash-warning">
              {noBash.join(", ")} ship{noBash.length === 1 ? "s" : ""} executable files, and the
              model runs them with the bash tool. This profile has no bash in its tool lists.
            </Alert>
          )}
          {broken && (
            <Alert variant="destructive" data-testid="broken-references">
              <p className="font-medium">This definition references things that no longer exist.</p>
              <p>The API refuses a new version until they are removed.</p>
              <Button
                className="mt-2"
                size="sm"
                variant="outline"
                onClick={() => {
                  setDraft({ ...draft, form: withoutBrokenReferences(form, refs) });
                }}
              >
                Remove all broken references
              </Button>
            </Alert>
          )}
          {settingsValues !== undefined && review !== undefined && (
            <AdmissionPreview settings={settingsValues} admission={review.admission} />
          )}
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
                This profile is enabled, but a session that picks it would be refused.
              </p>
              {review.warnings.map((warning) => (
                <p key={warning.name} className="break-words">
                  {warning.refused.message}. {warning.refused.fix}
                </p>
              ))}
            </Alert>
          )}
          {settings.isError && <Alert variant="destructive">{settings.error.message}</Alert>}
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
              disabled={!canSave || save.isPending}
              onClick={() => {
                save.mutate();
              }}
            >
              {save.isPending ? "Saving" : creating ? "Create profile" : "Publish new version"}
            </Button>
            <Button
              variant="ghost"
              disabled={save.isPending}
              onClick={() => {
                setDraft(undefined);
                setConflict(undefined);
              }}
            >
              Discard changes
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
