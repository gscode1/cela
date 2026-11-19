import { Link, useParams } from "react-router";
import { Breadcrumb } from "@/components/breadcrumb";
import { ProfileLinks } from "@/components/profile-ref-links";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useProfilesQuery, useRuleSetQuery, useRuleSetsQuery } from "@/lib/queries";
import { profilesUsing } from "@/pages/egress/rule-sets";
import { RuleManager } from "@/pages/egress/rule-manager";

export function RuleSetDetail() {
  const { name = "" } = useParams();
  const detail = useRuleSetQuery(name);
  // Writes send the revision of the whole schema; the set's own `revision` is the one of its last write.
  const list = useRuleSetsQuery();
  const profiles = useProfilesQuery();
  const using = profiles.data === undefined ? [] : profilesUsing(profiles.data.profiles, name);
  return (
    <div className="flex flex-col gap-4">
      <Breadcrumb items={[{ label: "Egress", to: "/egress" }, { label: name }]} />
      {detail.isError && <Alert variant="destructive">{detail.error.message}</Alert>}
      {detail.isSuccess && (
        <Card>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2">
              {detail.data.name}
              {detail.data.appliesToAll && <Badge variant="warning">Applies to all sessions</Badge>}
              {detail.data.system === true && (
                <Badge variant="outline">Derived from the MCP catalog</Badge>
              )}
            </CardTitle>
            <CardDescription>{detail.data.description}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {detail.data.system === true && (
              <Alert data-testid="system-set-note">
                Derived from the MCP server catalog and read-only. One rule per host of an enabled
                server, <code>onecli</code> for a server with a credential, <code>direct</code>{" "}
                otherwise. The orchestrator reaches these hosts for the sessions whose profile names
                the server; no profile names this set. Change it by editing{" "}
                <Link className="underline" to="/mcp-servers">
                  the MCP servers
                </Link>
                .
              </Alert>
            )}
            <p className="text-sm text-muted-foreground">
              Used by {using.length === 0 ? "no profile" : <ProfileLinks profiles={using} />}
              {detail.data.appliesToAll ? ", and by every session." : "."}
            </p>
            <RuleManager
              owner={{ ruleSet: detail.data.name }}
              rules={detail.data.rules}
              revision={list.data?.revision}
              readOnly={detail.data.system === true}
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
