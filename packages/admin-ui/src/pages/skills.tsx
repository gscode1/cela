import { useQuery } from "@tanstack/react-query";
import { Link, Route, Routes } from "react-router";
import { useAuth } from "@/auth";
import { ProfileLinks } from "@/components/profile-ref-links";
import { ReadOnlyNote } from "@/components/read-only-note";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, Td, Th } from "@/components/ui/table";
import { listProfileRefs } from "@/lib/api/profile-refs";
import { listSkills, profilesPinningAny } from "@/lib/api/skills";
import { useCatalogMode } from "@/lib/use-catalog-mode";
import { SkillDetail } from "@/pages/skills-detail";
import { NEW_SKILL, SkillPublish } from "@/pages/skills-publish";

function PublishButton() {
  return (
    <Link to={`/skills/${NEW_SKILL}/publish`}>
      <Button size="sm">Add skill</Button>
    </Link>
  );
}

function SkillList() {
  const { token } = useAuth();
  const { mode, error: modeError } = useCatalogMode();
  const skills = useQuery({
    queryKey: ["skills"],
    queryFn: ({ signal }) => listSkills(token ?? "", signal),
  });
  const profiles = useQuery({
    queryKey: ["profile-refs"],
    queryFn: ({ signal }) => listProfileRefs(token ?? "", signal),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Skills</CardTitle>
        <CardDescription>A profile uses a skill only when it pins a version.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {modeError !== undefined && <Alert variant="destructive">{modeError}</Alert>}
        {mode === "readOnly" && <ReadOnlyNote what="Skills" />}
        {mode === "manage" && (skills.data?.length ?? 0) > 0 && (
          <div>
            <PublishButton />
          </div>
        )}
        {skills.isError && <Alert variant="destructive">{skills.error.message}</Alert>}
        {profiles.isError && (
          <Alert variant="destructive">
            Could not load which profiles use them: {profiles.error.message}
          </Alert>
        )}
        {skills.isSuccess && skills.data.length === 0 && (
          <div className="flex flex-col items-start gap-3">
            <p className="text-sm">No skills yet.</p>
            {mode === "manage" && <PublishButton />}
          </div>
        )}
        {skills.isSuccess && skills.data.length > 0 && (
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Current</Th>
                <Th>Description</Th>
                <Th>Used by</Th>
              </tr>
            </thead>
            <tbody>
              {skills.data.map((skill) => {
                const users =
                  profiles.data === undefined
                    ? undefined
                    : profilesPinningAny(profiles.data, skill.name);
                return (
                  <tr key={skill.name} data-testid={`skill-${skill.name}`}>
                    <Td>
                      <Link className="underline" to={`/skills/${encodeURIComponent(skill.name)}`}>
                        {skill.name}
                      </Link>
                    </Td>
                    <Td>
                      v{skill.currentVersion}{" "}
                      {skill.disableModelInvocation && <Badge>manual only</Badge>}
                    </Td>
                    <Td className="break-words">{skill.description}</Td>
                    <Td>
                      {users === undefined ? (
                        ""
                      ) : users.length === 0 ? (
                        <span className="text-muted-foreground">{"—"}</span>
                      ) : (
                        <ProfileLinks profiles={users} />
                      )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

export function SkillsRoutes() {
  return (
    <Routes>
      <Route index element={<SkillList />} />
      <Route path=":name" element={<SkillDetail />} />
      <Route path=":name/publish" element={<SkillPublish />} />
    </Routes>
  );
}
