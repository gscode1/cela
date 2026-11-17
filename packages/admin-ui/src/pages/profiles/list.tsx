import { Link, useSearchParams } from "react-router";
import { ChangedCell } from "@/components/changed";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { describeIntent, hasIntent, intentFromSearch, searchOf } from "@/lib/profile-links";
import { useProfilesQuery } from "@/lib/queries";

export function ProfileList() {
  const profiles = useProfilesQuery();
  const data = profiles.data;
  const [params] = useSearchParams();
  const intent = intentFromSearch(params);
  // Carried on to the profile's own route, where the draft is prepared.
  const search = searchOf(intent);
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <CardTitle>Session profiles</CardTitle>
          <CardDescription>
            What a new session gets. Profiles can be disabled, not deleted.
          </CardDescription>
        </div>
        <Link className={buttonVariants()} to="/profiles/new">
          New profile
        </Link>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {hasIntent(intent) && (
          <Alert role="status" data-testid="choose-profile">
            Choose the profile to {describeIntent(intent)}. Nothing is saved: the profile opens with
            the change in its draft and you publish it yourself.
          </Alert>
        )}
        {profiles.isError && <Alert variant="destructive">{profiles.error.message}</Alert>}
        {data === undefined && !profiles.isError && (
          <p className="text-sm text-muted-foreground">Loading</p>
        )}
        {data !== undefined && (
          <table className="w-full text-left text-sm" aria-label="Profiles">
            <thead>
              <tr className="text-muted-foreground">
                <th className="py-1 pr-4 font-medium">Name</th>
                <th className="py-1 font-medium">Last changed</th>
              </tr>
            </thead>
            <tbody>
              {data.profiles.map((profile) => (
                <tr key={profile.name} className="border-t align-top">
                  <td className="py-2 pr-4">
                    <Link
                      className="font-medium underline-offset-4 hover:underline"
                      to={`/profiles/${profile.name}${search}`}
                    >
                      {profile.name}
                    </Link>
                    {profile.name === data.defaultProfile && (
                      <Badge className="ml-2" variant="outline">
                        default
                      </Badge>
                    )}
                    {!profile.enabledForNew && (
                      <Badge className="ml-2" variant="destructive">
                        disabled
                      </Badge>
                    )}
                  </td>
                  <td className="py-2 break-words">
                    <ChangedCell by={profile.updatedBy} at={profile.updatedAt} />
                  </td>
                </tr>
              ))}
              {data.invalid.map((entry) => (
                <tr key={entry.name} className="border-t align-top" data-testid="invalid-profile">
                  <td className="py-2 pr-4">
                    <span className="font-medium">{entry.name}</span>
                    {entry.name === data.defaultProfile && (
                      <Badge className="ml-2" variant="outline">
                        default
                      </Badge>
                    )}
                  </td>
                  <td className="py-2">
                    <Badge variant="destructive">invalid</Badge>{" "}
                    <span className="break-words" title={entry.message}>
                      This profile&apos;s stored definition is invalid; publish a corrected version.
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}
