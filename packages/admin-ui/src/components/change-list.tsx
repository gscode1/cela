import type { FieldChange } from "@/lib/diff";

/** Previous and new value per field. Every value is text, so API content cannot become markup. */
export function ChangeList({
  changes,
  beforeLabel = "Previous",
  afterLabel = "New",
}: {
  changes: readonly FieldChange[];
  beforeLabel?: string;
  afterLabel?: string;
}) {
  if (changes.length === 0) return <p className="text-sm text-muted-foreground">No changes.</p>;
  return (
    <table className="w-full text-left text-sm">
      <thead>
        <tr className="text-muted-foreground">
          <th className="py-1 pr-4 font-medium">Field</th>
          <th className="py-1 pr-4 font-medium">{beforeLabel}</th>
          <th className="py-1 font-medium">{afterLabel}</th>
        </tr>
      </thead>
      <tbody>
        {changes.map((change) => (
          <tr key={change.field} className="border-t align-top">
            <td className="py-1 pr-4 font-mono text-xs">{change.field}</td>
            <td className="py-1 pr-4 break-words whitespace-pre-wrap">{change.before}</td>
            <td className="py-1 break-words whitespace-pre-wrap">{change.after}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
