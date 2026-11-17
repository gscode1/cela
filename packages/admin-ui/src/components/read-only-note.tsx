import { Alert } from "@/components/ui/alert";

/** Shown on the catalog screens of an install with `console.catalogs: readOnly`. */
export function ReadOnlyNote({ what }: { what: string }) {
  return (
    <Alert>
      {what} are read-only in this console (<code>console.catalogs: readOnly</code>). You can browse
      them and download skill zips. This hides the controls only; the admin API still accepts writes
      from any admin.
    </Alert>
  );
}
