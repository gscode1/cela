import { adminFetch } from "@/lib/api";

/** One model of the catalog the orchestrator published (docs/session-api.md, `GET /admin/models`). */
export interface CatalogModel {
  provider: string;
  id: string;
  name?: string;
  /** Whether the model supports reasoning levels. */
  reasoning: boolean;
  contextWindow?: number;
  maxTokens?: number;
}

export interface ModelProvider {
  provider: string;
  credential: "configured" | "missing" | "unknown";
}

/** The default view: only providers with a OneCLI credential, never `scripted`. */
export interface ModelCatalog {
  models: CatalogModel[];
  providers: ModelProvider[];
  source: "orchestrator" | "none";
  filtered: boolean;
  credentials?: "configured" | "none-configured" | "unknown";
  reason?: string;
}

export function getModels(token: string, signal?: AbortSignal): Promise<ModelCatalog> {
  return adminFetch<ModelCatalog>(token, "/admin/models", signal ? { signal } : {});
}
