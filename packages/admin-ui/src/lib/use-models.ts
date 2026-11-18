import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/auth";
import { getModels } from "@/lib/api/models";
import { viewOf } from "@/lib/models";
import type { ModelView } from "@/lib/models";

/** The model catalog for the pickers, as a view the screens can switch on. */
export function useModelView(): ModelView {
  const { token } = useAuth();
  const query = useQuery({
    queryKey: ["models"],
    queryFn: ({ signal }) => getModels(token ?? "", signal),
    // The credential hint changes behind the console (a secret added in OneCLI, ADR 0025): coming back to the tab shows it.
    refetchOnWindowFocus: true,
  });
  return viewOf(query.data, query.isError ? query.error.message : undefined, query.isPending);
}
