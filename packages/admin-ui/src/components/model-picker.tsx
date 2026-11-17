import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { currentNote, groupKeys, idOf, keyOf, modelLabel, providerOf } from "@/lib/models";
import type { ModelView } from "@/lib/models";

const SEARCH_ABOVE = 15;

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
  const note = value === "" ? undefined : currentNote(view, value);
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
  const providers = [...new Set(view.models.map((model) => model.provider))];
  const currentProvider = providerOf(value);
  const provider = value === "" ? (providers[0] ?? "") : currentProvider;
  const providerOptions =
    provider === "" || providers.includes(provider) ? providers : [provider, ...providers];
  const ofProvider = view.models.filter((model) => model.provider === provider);
  const offered = ofProvider.some((model) => keyOf(model) === value);
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
        <Select
          id={id}
          value={value}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        >
          {value !== "" && !offered && <option value={value}>{idOf(value)}</option>}
          {ofProvider.map((model) => (
            <option key={keyOf(model)} value={keyOf(model)}>
              {model.name ?? model.id}
              {model.reasoning ? " · reasoning" : ""}
            </option>
          ))}
        </Select>
      </div>
      {note !== undefined && <p className="text-xs text-muted-foreground">{note}</p>}
    </div>
  );
}

/** The profile's model override: the allowlisted models, grouped by provider, under their display names. */
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
      {groupKeys(allowed, view.models).map((group) => (
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

/**
 * The allowlist as a checklist over the catalog. The default model is always in it and shown as such; current entries
 * the catalog does not list stay visible so they can be removed.
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
  const [search, setSearch] = useState("");
  const listed = new Set(view.models.map(keyOf));
  // Entries the catalog does not list stay on screen after they are unticked, so a click can be undone.
  const [seen] = useState(() => [...value]);
  const extra = [...new Set([...seen, ...value])].filter(
    (key) => key !== defaultModel && !listed.has(key),
  );
  const needle = search.trim().toLowerCase();
  const shown = view.models.filter(
    (model) =>
      keyOf(model) !== defaultModel &&
      (needle === "" || `${model.name ?? ""} ${keyOf(model)}`.toLowerCase().includes(needle)),
  );
  const toggle = (key: string, on: boolean): void => {
    onChange(on ? [...value, key] : value.filter((entry) => entry !== key));
  };
  const row = (key: string, label: string, extraNode?: React.ReactNode, tag?: boolean) => (
    <div key={key} className="flex flex-wrap items-center gap-2 text-sm">
      <Checkbox
        id={`allow-${key}`}
        checked={value.includes(key)}
        onChange={(event) => {
          toggle(key, event.target.checked);
        }}
      />
      <Label htmlFor={`allow-${key}`}>{label}</Label>
      {tag === true && <Badge variant="outline">reasoning</Badge>}
      {extraNode}
    </div>
  );
  return (
    <fieldset className="flex flex-col gap-2 rounded-lg border p-4">
      <legend className="px-1 text-sm font-medium">Allowed models</legend>
      {view.models.length > SEARCH_ABOVE && (
        <Input
          aria-label="Search models"
          placeholder="Search models"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
          }}
        />
      )}
      <div className="flex flex-col gap-1.5" data-testid="allowed-models">
        {defaultModel !== "" && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Checkbox id="allow-default" checked disabled />
            <Label htmlFor="allow-default">{modelLabel(view.models, defaultModel)}</Label>
            <Badge variant="outline">default</Badge>
          </div>
        )}
        {extra.map((key) =>
          row(
            key,
            key,
            <span className="text-xs text-muted-foreground">{currentNote(view, key)}</span>,
          ),
        )}
        {groupKeys(shown.map(keyOf), view.models).map((group) => (
          <div key={group.provider} className="flex flex-col gap-1.5">
            <p className="mt-1 text-xs font-medium text-muted-foreground">{group.provider}</p>
            {group.options.map((option) =>
              row(option.key, option.label, undefined, option.reasoning),
            )}
          </div>
        ))}
      </div>
      {view.mode !== "list" && view.mode !== "loading" && (
        <ModelIdInput
          id="allowed-custom"
          onUse={(key) => {
            if (key !== defaultModel && !value.includes(key)) onChange([...value, key]);
          }}
        />
      )}
    </fieldset>
  );
}
