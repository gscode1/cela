import type { UseQueryResult } from "@tanstack/react-query";
import {
  useEgressStatusQuery,
  useMcpCatalogQuery,
  useModelsQuery,
  useNetworkModesQuery,
  useSandboxFlavoursQuery,
  useSandboxSizesQuery,
  useStatusQuery,
  useToolsQuery,
} from "@/lib/queries";
import { hasProblem, statusRows } from "@/lib/status-rows";
import type { Source, StatusInputs, StatusRow } from "@/lib/status-rows";

const sourceOf = <T>(query: UseQueryResult<T>): Source<T> =>
  query.isSuccess
    ? { state: "ok", data: query.data }
    : query.isError
      ? { state: "error", message: query.error.message }
      : { state: "loading" };

/** The readers behind every row that can be a problem; the page and the navigation dot share them. */
function useCore() {
  const queries = {
    status: useStatusQuery(),
    egress: useEgressStatusQuery(),
    models: useModelsQuery(),
    mcp: useMcpCatalogQuery(),
  };
  const inputs = {
    status: sourceOf(queries.status),
    egress: sourceOf(queries.egress),
    models: sourceOf(queries.models),
    mcp: sourceOf(queries.mcp),
  };
  return { queries, inputs };
}

/** Whether any area is wrong now: the red dot on the Status entry of the navigation. */
export function useStatusProblem(): boolean {
  return hasProblem(statusRows(useCore().inputs));
}

/** The page's rows, with the chart facts, and one refresh for all of its readers. */
export function useStatusRows(): {
  rows: StatusRow[];
  inputs: StatusInputs;
  refresh: () => void;
  fetching: boolean;
} {
  const { queries, inputs: core } = useCore();
  const deployment = {
    networkModes: useNetworkModesQuery(),
    flavours: useSandboxFlavoursQuery(),
    sizes: useSandboxSizesQuery(),
    tools: useToolsQuery(),
  };
  const inputs: StatusInputs = {
    ...core,
    deployment: {
      networkModes: sourceOf(deployment.networkModes),
      flavours: sourceOf(deployment.flavours),
      sizes: sourceOf(deployment.sizes),
      tools: sourceOf(deployment.tools),
    },
  };
  const all: UseQueryResult[] = [...Object.values(queries), ...Object.values(deployment)];
  return {
    rows: statusRows(inputs),
    inputs,
    refresh: () => {
      for (const query of all) void query.refetch();
    },
    fetching: all.some((query) => query.isFetching),
  };
}
