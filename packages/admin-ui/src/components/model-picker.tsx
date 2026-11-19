import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/combobox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  currentNote,
  groupKeys,
  isScripted,
  keyOf,
  modelLabel,
  providerOf,
  SCRIPTED_NOTE,
  shownAllowlist,
} from "@/lib/models";
import type { ModelView, PickOption } from "@/lib/models";
import type { CatalogModel } from "@/lib/api/models";

/** More allowlisted models than this and the profile's override becomes a search, and the allowlist folds. */
export const COMBOBOX_ABOVE = 15;

const optionOf = (model: CatalogModel): PickOption => ({
  key: keyOf(model),
  label: model.name ?? model.id,
  search: model.id,
});

const providersOf = (view: ModelView): string[] => [
  ...new Set(view.models.map((model) => model.provider)),
];

/** One line that says why there is no list; undefined when there is one (or it is still loading). */
export function ModelNotice({ view }: { view: ModelView }) {
  if (view.mode === "none-configured")
    return (
      <p className="text-sm text-muted-foreground" data-testid="models-notice">
        No model credentials are configured in OneCLI yet.
      </p>
    );
  if (view.mode === "unknown")
    return (
      <p
        className="text-sm text-muted-foreground"
        data-testid="models-notice"
        {...(view.reason === undefined ? {} : { title: view.reason })}
      >
        Could not check OneCLI for model credentials.
      </p>
    );
  return null;
}

/** The escape hatch of a screen without a list: a model id typed by hand, which the server validates. */
function ModelIdInput({ id, onUse }: { id: string; onUse: (key: string) => void }) {
  const [text, setText] = useState("");
  return (
    <div className="flex items-end gap-2">
      <div className="flex flex-col gap-1">
        <Label htmlFor={id} className="text-xs text-muted-foreground">
          Enter a model id
        </Label>
        <Input
          id={id}
          className="h-8 w-64"
          placeholder="provider/model"
          value={text}
          onChange={(event) => {
            setText(event.target.value);
          }}
        />
      </div>
      <Button
        size="sm"
        variant="outline"
        disabled={text.trim() === ""}
        onClick={() => {
          onUse(text.trim());
          setText("");
        }}
      >
        Use
      </Button>
    </div>
  );
}

/** Provider, then model: the default model. A current value the list lacks stays selectable as the current one. */
export function ModelSelect({
  id,
  value,
  view,
  onChange,
}: {
  id: string;
  value: string;
  view: ModelView;
  onChange: (key: string) => void;
}) {
  // The scripted note is the allowlist's to give: the default model is always listed there.
  const note = value === "" || isScripted(value) ? undefined : currentNote(view, value);
  if (view.mode !== "list") {
    return (
      <div className="flex flex-col gap-2">
        <p id={id} className="text-sm break-all" data-testid="current-model">
          {value}
        </p>
        {note !== undefined && <p className="text-xs text-muted-foreground">{note}</p>}
        {view.mode !== "loading" && <ModelIdInput id={`${id}-custom`} onUse={onChange} />}
      </div>
    );
  }
  const providers = providersOf(view);
  const currentProvider = providerOf(value);
  const provider = value === "" ? (providers[0] ?? "") : currentProvider;
  const providerOptions =
    provider === "" || providers.includes(provider) ? providers : [provider, ...providers];
  const options = view.models.filter((model) => model.provider === provider).map(optionOf);
  return (
    <div className="flex flex-col gap-2">
      <div className="grid gap-2 sm:grid-cols-2">
        <Select
          aria-label="Provider"
          value={provider}
          onChange={(event) => {
            const first = view.models.find((model) => model.provider === event.target.value);
            if (first !== undefined) onChange(keyOf(first));
          }}
        >
          {providerOptions.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </Select>
        <Combobox
          id={id}
          options={options}
          display={value === "" ? "" : modelLabel(view.models, value)}
          placeholder="Search models"
          onPick={onChange}
        />
      </div>
      {note !== undefined && <p className="text-xs text-muted-foreground">{note}</p>}
    </div>
  );
}

/**
 * The profile's model override: the allowlisted models, grouped by provider, under their display names. A plain select
 * while the allowlist is short; a search past `COMBOBOX_ABOVE` entries.
 */
export function AllowedModelSelect({
  id,
  value,
  allowed,
  view,
  inheritLabel,
  onChange,
}: {
  id: string;
  value: string;
  allowed: readonly string[];
  view: ModelView;
  inheritLabel: string;
  onChange: (key: string) => void;
}) {
  const stale = value !== "" && !allowed.includes(value);
  const shown = shownAllowlist(allowed, value);
  if (shown.length > COMBOBOX_ABOVE) {
    const options: PickOption[] = [
      { key: "", label: inheritLabel },
      ...shown.map((key) => ({
        key,
        label: modelLabel(view.models, key),
        search: key,
      })),
    ];
    return (
      <div className="flex flex-col gap-1">
        <Combobox
          id={id}
          options={options}
          display={value === "" ? inheritLabel : modelLabel(view.models, value)}
          placeholder="Search models"
          onPick={onChange}
        />
        {stale && <p className="text-xs text-muted-foreground">{value} is not allowed.</p>}
      </div>
    );
  }
  return (
    <Select
      id={id}
      value={value}
      onChange={(event) => {
        onChange(event.target.value);
      }}
    >
      <option value="">{inheritLabel}</option>
      {stale && <option value={value}>{value} (not allowed)</option>}
      {groupKeys(shown, view.models).map((group) => (
        <optgroup key={group.provider} label={group.provider}>
          {group.options.map((option) => (
            <option key={option.key} value={option.key}>
              {option.label}
            </option>
          ))}
        </optgroup>
      ))}
    </Select>
  );
}

/** The allowlist after taking `key` out, or after adding it unless it is the default or already there. */
export const withoutModel = (list: readonly string[], key: string): string[] =>
  list.filter((entry) => entry !== key);
export const withModel = (list: readonly string[], key: string, defaultModel: string): string[] =>
  key === defaultModel || list.includes(key) ? [...list] : [...list, key];

/**
 * The allowlist as the models that are in it, each removable, and an "Add a model" search below. The default model is
 * always in it and cannot be removed. The catalog is never listed whole: a provider can have hundreds of models.
 */
export function AllowedModels({
  value,
  defaultModel,
  view,
  onChange,
}: {
  value: readonly string[];
  defaultModel: string;
  view: ModelView;
  onChange: (next: string[]) => void;
}) {
  const providers = providersOf(view);
  const [picked, setPicked] = useState("");
  const [all, setAll] = useState(false);
  const provider = providers.includes(picked) ? picked : (providers[0] ?? "");
  const entries = shownAllowlist(
    [
      ...(defaultModel === "" ? [] : [defaultModel]),
      ...value.filter((key) => key !== defaultModel),
    ],
    defaultModel,
  );
  const visible = all ? entries : entries.slice(0, COMBOBOX_ABOVE);
  const options = view.models
    .filter(
      (model) =>
        model.provider === provider &&
        keyOf(model) !== defaultModel &&
        !value.includes(keyOf(model)),
    )
    .map(optionOf);
  return (
    <fieldset className="flex flex-col gap-3 rounded-lg border p-4">
      <legend className="px-1 text-sm font-medium">Allowed models</legend>
      <ul className="flex flex-col gap-1.5" data-testid="allowed-models">
        {visible.map((key) => {
          const label = modelLabel(view.models, key);
          const note = isScripted(key) ? undefined : currentNote(view, key);
          return (
            <li key={key} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="break-all">{label}</span>
              <span className="text-xs text-muted-foreground">{providerOf(key)}</span>
              {key === defaultModel && <Badge variant="outline">default</Badge>}
              {note !== undefined && <span className="text-xs text-muted-foreground">{note}</span>}
              {key !== defaultModel && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2"
                  aria-label={`Remove ${label} (${providerOf(key)})`}
                  onClick={() => {
                    onChange(withoutModel(value, key));
                  }}
                >
                  {"×"}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      {entries.length > visible.length && (
        <Button
          size="sm"
          variant="outline"
          className="self-start"
          onClick={() => {
            setAll(true);
          }}
        >
          Show all {entries.length}
        </Button>
      )}
      {entries.some(isScripted) && <p className="text-xs text-muted-foreground">{SCRIPTED_NOTE}</p>}
      {view.mode === "list" && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="allowed-add" className="text-xs text-muted-foreground">
            Add a model
          </Label>
          <div className="grid gap-2 sm:grid-cols-2">
            <Select
              aria-label="Provider to add from"
              value={provider}
              onChange={(event) => {
                setPicked(event.target.value);
              }}
            >
              {providers.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </Select>
            <Combobox
              id="allowed-add"
              options={options}
              display=""
              placeholder="Search models"
              onPick={(key) => {
                onChange(withModel(value, key, defaultModel));
              }}
            />
          </div>
        </div>
      )}
      {view.mode !== "list" && view.mode !== "loading" && (
        <ModelIdInput
          id="allowed-custom"
          onUse={(key) => {
            onChange(withModel(value, key, defaultModel));
          }}
        />
      )}
    </fieldset>
  );
}
