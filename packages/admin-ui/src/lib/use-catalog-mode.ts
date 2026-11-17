import { useQuery } from "@tanstack/react-query";
import { getCatalogMode } from "@/lib/catalog-config";
import type { CatalogMode } from "@/lib/catalog-config";

/** The install's catalog mode; `loading` until `/console/config.json` answers, so no write control shows meanwhile. */
export function useCatalogMode(): { mode: CatalogMode | "loading"; error: string | undefined } {
  const query = useQuery({
    queryKey: ["catalog-mode"],
    queryFn: ({ signal }) => getCatalogMode(signal),
    staleTime: Infinity,
  });
  return {
    mode: query.data ?? "loading",
    error: query.isError ? query.error.message : undefined,
  };
}
