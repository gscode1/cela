import { Link } from "react-router";
import type { ProfileRef } from "@/lib/api/profile-refs";

/** What a link needs of a profile. */
export type ProfileLinkRef = Pick<ProfileRef, "name" | "enabledForNew">;

/** Links to the profiles that use something; a profile closed to new sessions says so. */
export function ProfileLinks({ profiles }: { profiles: readonly ProfileLinkRef[] }) {
  return (
    <span className="inline-flex flex-wrap gap-x-2">
      {profiles.map((profile) => (
        <Link
          key={profile.name}
          className="underline"
          to={`/profiles/${encodeURIComponent(profile.name)}`}
        >
          {profile.name}
          {profile.enabledForNew ? "" : " (disabled)"}
        </Link>
      ))}
    </span>
  );
}
