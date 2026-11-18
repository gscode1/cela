import { Link, useParams } from "react-router";
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
      <p className="text-sm">
        <Link className="underline" to="/egress">
          All rule sets
        </Link>
      </p>
      {detail.isError && <Alert variant="destructive">{detail.error.message}</Alert>}
      {detail.isSuccess && (
        <Card>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2">
              {detail.data.name}
              {detail.data.appliesToAll && <Badge variant="warning">Applies to all sessions</Badge>}
            </CardTitle>
            <CardDescription>{detail.data.description}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              Used by {using.length === 0 ? "no profile" : <ProfileLinks profiles={using} />}
              {detail.data.appliesToAll ? ", and by every session." : "."}
            </p>
            <RuleManager
              owner={{ ruleSet: detail.data.name }}
              rules={detail.data.rules}
              revision={list.data?.revision}
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
