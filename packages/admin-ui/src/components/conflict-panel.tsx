import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ChangeList } from "@/components/change-list";
import type { FieldChange } from "@/lib/diff";

export interface ConflictView {
  /** The API's own message. */
  message: string;
  /** Set after "Reload and compare": what the server holds now. */
  current?: { revision: number; updatedBy: string; updatedAt: string };
  /** The fields where the server's current value differs from the draft: server on the left, draft on the right. */
  changes?: FieldChange[];
}

/**
 * A save the API refused because the resource moved on (`409`). The draft stays as it was; the operator reloads to
 * compare, then keeps editing on top of the server's version or drops the draft.
 */
export function ConflictPanel({
  what,
  conflict,
  busy,
  onReload,
  onRebase,
  onDiscard,
}: {
  what: string;
  conflict: ConflictView;
  busy: boolean;
  onReload: () => void;
  onRebase: () => void;
  onDiscard: () => void;
}) {
  return (
    <Alert variant="warning" className="flex flex-col gap-3">
      <p className="font-medium">Not saved: {what} changed since you started editing.</p>
      <p className="break-words">{conflict.message}</p>
      <p>Your draft is kept. Nothing was written.</p>
      {conflict.current !== undefined && (
        <div className="flex flex-col gap-2" data-testid="conflict-compare">
          <p>
            On the server now: revision {conflict.current.revision}, changed by{" "}
            {conflict.current.updatedBy} at {conflict.current.updatedAt}.
          </p>
          <ChangeList
            changes={conflict.changes ?? []}
            beforeLabel="On the server now"
            afterLabel="Your draft"
          />
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {conflict.current === undefined ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={onReload}>
            Reload and compare
          </Button>
        ) : (
          <Button size="sm" variant="outline" disabled={busy} onClick={onRebase}>
            Keep my draft on top of the server version
          </Button>
        )}
        <Button size="sm" variant="ghost" disabled={busy} onClick={onDiscard}>
          Discard my draft
        </Button>
      </div>
    </Alert>
  );
}
