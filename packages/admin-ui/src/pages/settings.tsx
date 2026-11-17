import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/auth";
import { Alert } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getSettings } from "@/lib/api";

/** Read-only for now; editing arrives with slice 2. Every value is rendered as text. */
export function GlobalSettings() {
  const { token } = useAuth();
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: ({ signal }) => getSettings(token ?? "", signal),
  });
  const rows: [string, string][] =
    settings.data === undefined
      ? []
      : [
          ["Default model", settings.data.defaultModel],
          ["Allowlist", settings.data.allowlist.join(", ")],
          ["Reasoning", settings.data.reasoning ?? "not set"],
          ["Max reasoning", settings.data.maxReasoning ?? "not set"],
          ["Default profile", settings.data.defaultProfile ?? "not set"],
          ["Turn budget", String(settings.data.turnBudget)],
          ["Last updated by", settings.data.updatedBy],
        ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Global settings</CardTitle>
        <CardDescription>Current values. Editing comes in a later slice.</CardDescription>
      </CardHeader>
      <CardContent>
        {settings.isError && <Alert variant="destructive">{settings.error.message}</Alert>}
        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="break-all">{value}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}
