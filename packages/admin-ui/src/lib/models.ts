import type { CatalogModel, ModelCatalog } from "@/lib/api/models";

export const SCRIPTED_NOTE = "Test model — replays the message as a script, no LLM.";
export const NOT_AVAILABLE_NOTE = "not available";

/**
 * What the pickers can offer. `list` has models to choose from; `none-configured` and `unknown` have none, and the
 * screens fall back to the current values as text plus a field for a model id (the server validates it).
 */
export type ModelView =
  | { mode: "loading"; models: [] }
  | { mode: "list"; models: CatalogModel[] }
  | { mode: "none-configured"; models: [] }
  | { mode: "unknown"; models: []; reason?: string };

export function viewOf(
  catalog: ModelCatalog | undefined,
  failure: string | undefined,
  loading: boolean,
): ModelView {
  if (catalog === undefined)
    return loading ? { mode: "loading", models: [] } : unknown(failure ?? undefined);
  if (catalog.credentials === "none-configured") return { mode: "none-configured", models: [] };
  if (catalog.credentials === "unknown") return unknown(catalog.reason);
  return { mode: "list", models: catalog.models };
}

function unknown(reason: string | undefined): ModelView {
  return reason === undefined
    ? { mode: "unknown", models: [] }
    : { mode: "unknown", models: [], reason };
}

export const keyOf = (model: { provider: string; id: string }): string =>
  `${model.provider}/${model.id}`;

export const providerOf = (key: string): string => {
  const slash = key.indexOf("/");
  return slash < 0 ? "" : key.slice(0, slash);
};

export const idOf = (key: string): string => key.slice(key.indexOf("/") + 1);

/** The test provider of CI and the quickstart: never offered, but shown when it is the current value. */
export const isScripted = (key: string): boolean => providerOf(key) === "scripted";

export function findModel(models: readonly CatalogModel[], key: string): CatalogModel | undefined {
  return models.find((model) => keyOf(model) === key);
}

/** The model's name, or its id when the catalog has no name or does not know the model. */
export function modelLabel(models: readonly CatalogModel[], key: string): string {
  const found = findModel(models, key);
  return found === undefined ? idOf(key) : (found.name ?? found.id);
}

/** True or false when the catalog knows the model; undefined when it cannot say (so levels are still offered). */
export function supportsReasoning(
  models: readonly CatalogModel[],
  key: string,
): boolean | undefined {
  return findModel(models, key)?.reasoning;
}

export interface ModelGroup {
  provider: string;
  options: { key: string; label: string; reasoning: boolean }[];
}

/** Keys grouped by provider, in first-seen order, labelled with the catalog's names. */
export function groupKeys(keys: readonly string[], models: readonly CatalogModel[]): ModelGroup[] {
  const groups: ModelGroup[] = [];
  for (const key of keys) {
    const provider = providerOf(key);
    let group = groups.find((entry) => entry.provider === provider);
    if (group === undefined) {
      group = { provider, options: [] };
      groups.push(group);
    }
    group.options.push({
      key,
      label: modelLabel(models, key),
      reasoning: findModel(models, key)?.reasoning === true,
    });
  }
  return groups;
}

/** The note for a current value the pickers do not offer, or undefined when the catalog lists it. */
export function currentNote(view: ModelView, key: string): string | undefined {
  if (isScripted(key)) return SCRIPTED_NOTE;
  if (view.mode === "list" && findModel(view.models, key) === undefined) return NOT_AVAILABLE_NOTE;
  return undefined;
}
