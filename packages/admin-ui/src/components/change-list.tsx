import { fieldLabel } from "@/lib/field-labels";
import type { FieldChange } from "@/lib/diff";

/**
 * Previous and new value per field, under the field's name. Every value is text, so API content cannot become markup.
 * `initial` is for the first values of something: no previous column.
 */
export function ChangeList({
  changes,
  beforeLabel = "Previous",
  afterLabel = "New",
  initial = false,
}: {
  changes: readonly FieldChange[];
  beforeLabel?: string;
  afterLabel?: string;
  initial?: boolean;
}) {
  if (changes.length === 0) return <p className="text-sm text-muted-foreground">No changes.</p>;
  return (
    <table className="w-full text-left text-sm">
      <thead>
        <tr className="text-muted-foreground">
          <th className="py-1 pr-4 font-medium">Field</th>
          {!initial && <th className="py-1 pr-4 font-medium">{beforeLabel}</th>}
          <th className="py-1 font-medium">{initial ? "Initial values" : afterLabel}</th>
        </tr>
      </thead>
      <tbody>
        {changes.map((change) => (
          <tr key={change.field} className="border-t align-top">
            <td className="py-1 pr-4">{fieldLabel(change.field)}</td>
            {!initial && (
              <td className="py-1 pr-4 break-words whitespace-pre-wrap">{change.before}</td>
            )}
            <td className="py-1 break-words whitespace-pre-wrap">{change.after}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
