import { Alert } from "@/components/ui/alert";
import { effectiveAllowlist } from "@/lib/admission";
import type { Admission } from "@/lib/admission";
import type { SettingsValues } from "@/lib/api/settings";

const SOURCE: Record<"profile" | "settings" | "none", string> = {
  profile: "from this profile",
  settings: "from the global settings",
  none: "not set",
};

/**
 * What a new session would get from this profile under the current settings (`admit`, src/lib/admission.ts). The
 * request is assumed to name no model, reasoning or profile of its own.
 */
export function AdmissionPreview({
  settings,
  admission,
}: {
  settings: SettingsValues;
  admission: Admission;
}) {
  return (
    <section aria-label="Admission preview" className="flex flex-col gap-2 text-sm">
      <h3 className="font-medium">Admission preview</h3>
      {admission.ok ? (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1">
          <dt className="text-muted-foreground">Model</dt>
          <dd className="break-all">
            {admission.model} ({SOURCE[admission.modelFrom]})
          </dd>
          <dt className="text-muted-foreground">Reasoning</dt>
          <dd>
            {admission.reasoning ?? "not set (Pi's default, off)"} (
            {SOURCE[admission.reasoningFrom]})
          </dd>
          <dt className="text-muted-foreground">Turn budget</dt>
          <dd>
            {admission.turnBudget} ({SOURCE[admission.turnBudgetFrom]})
          </dd>
          <dt className="text-muted-foreground">Allowlist</dt>
          <dd className="break-all">{effectiveAllowlist(settings).join(", ")}</dd>
        </dl>
      ) : (
        <Alert variant="warning" data-testid="refusal">
          <p className="font-medium">A new session with this profile would be refused.</p>
          <p className="break-words">{admission.message}</p>
          <p>{admission.fix}</p>
        </Alert>
      )}
      <p className="text-xs text-muted-foreground">
        Assumes the request names no model, reasoning or profile of its own. Provider availability,
        credentials and whether the model supports reasoning are only known at the first turn.
      </p>
    </section>
  );
}
