import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useAuth } from "@/auth";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api";
import { listRuleSets } from "@/lib/api/egress";
import type { EgressEffect } from "@/lib/api/egress";
import { isStaleMessage } from "@/lib/egress-form";
import { keys } from "@/lib/queries";

/**
 * The revision a write sends as `expectedRevision` (ADR 0023, ADR 0034): the one the page showed when the form opened,
 * not a later refetch, so a change by someone else since then is caught. After a stale refusal "Reload" fetches the
 * current revision; the operator's input is kept and a second save lands on top of what is stored now.
 */
export function useRevisionBase(opened: number): {
  base: number;
  reload: () => void;
  reloading: boolean;
  reloaded: boolean;
  reloadError: string | undefined;
} {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  const [base, setBase] = useState(opened);
  const [reloaded, setReloaded] = useState(false);
  const reload = useMutation({
    mutationFn: () => listRuleSets(token ?? ""),
    onSuccess: async (list) => {
      queryClient.setQueryData(keys.egressRuleSets, list);
      await queryClient.invalidateQueries({ queryKey: keys.egress });
      setBase(list.revision);
      setReloaded(true);
    },
  });
  return {
    base,
    reload: () => {
      reload.mutate();
    },
    reloading: reload.isPending,
    reloaded,
    reloadError: reload.isError ? reload.error.message : undefined,
  };
}

/** What a refused write says. A stale revision offers the reload; every other message is the API's own. */
export function WriteError({
  error,
  revision,
}: {
  error: unknown;
  revision: ReturnType<typeof useRevisionBase>;
}) {
  if (!(error instanceof Error)) return null;
  const stale = error instanceof ApiError && error.status === 409 && isStaleMessage(error.message);
  if (!stale) return <Alert variant="destructive">{error.message}</Alert>;
  return (
    <Alert variant="warning" className="flex flex-col gap-2" data-testid="egress-conflict">
      <p className="font-medium">Not saved: the egress rules changed since you opened this page.</p>
      <p>Your input is kept. Nothing was written.</p>
      {revision.reloaded ? (
        <p>Reloaded. Save again to apply your input on top of the current rules.</p>
      ) : (
        <div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={revision.reloading}
            onClick={revision.reload}
          >
            Reload the rules
          </Button>
        </div>
      )}
      {revision.reloadError !== undefined && (
        <p className="text-destructive">{revision.reloadError}</p>
      )}
    </Alert>
  );
}

export function EffectBadge({ effect }: { effect: EgressEffect }) {
  return <Badge variant={effect === "allow" ? "secondary" : "destructive"}>{effect}</Badge>;
}
