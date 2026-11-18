import { Alert } from "@/components/ui/alert";
import type { Admission } from "@/lib/admission";

const SOURCE: Record<"profile" | "settings" | "none", string> = {
  profile: "from this profile",
  settings: "from the global settings",
  none: "",
};

/**
 * What a new session would get from this profile under the current settings (`admit`, src/lib/admission.ts). The
 * request is assumed to name no model, reasoning or profile of its own. Collapsed unless the session would be refused.
 */
export function AdmissionPreview({ admission }: { admission: Admission }) {
  return (
    <section aria-label="What a new session gets" className="text-sm">
      <details {...(admission.ok ? {} : { open: true })}>
        <summary className="cursor-pointer font-medium">What a new session gets</summary>
        <div className="mt-2 flex flex-col gap-2">
          {admission.ok ? (
            <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1">
              <dt className="text-muted-foreground">Model</dt>
              <dd className="break-all">
                {admission.model} ({SOURCE[admission.modelFrom]})
              </dd>
              <dt className="text-muted-foreground">Reasoning</dt>
              <dd>
                {admission.reasoning ?? "off"}
                {admission.reasoningFrom === "none" ? "" : ` (${SOURCE[admission.reasoningFrom]})`}
              </dd>
              <dt className="text-muted-foreground">Turn budget</dt>
              <dd>
                {admission.turnBudget} ({SOURCE[admission.turnBudgetFrom]})
              </dd>
              <dt className="text-muted-foreground">Token budget</dt>
              <dd>
                {admission.tokenBudget ?? "no limit"} ({SOURCE[admission.tokenBudgetFrom]})
              </dd>
            </dl>
          ) : (
            <Alert variant="warning" data-testid="refusal">
              <p className="font-medium">A new session with this profile would be refused.</p>
              <p className="break-words">{admission.message}</p>
              <p>{admission.fix}</p>
            </Alert>
          )}
          <p className="text-xs text-muted-foreground">
            Credentials are only checked at the first turn.
          </p>
        </div>
      </details>
    </section>
  );
}
