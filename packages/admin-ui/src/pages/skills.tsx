import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, Route, Routes, useNavigate } from "react-router";
import { useAuth } from "@/auth";
import { ReadOnlyNote } from "@/components/read-only-note";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, Td, Th } from "@/components/ui/table";
import { listSkills } from "@/lib/api/skills";
import { SKILL_NAME } from "@/lib/skills/limits";
import { useCatalogMode } from "@/lib/use-catalog-mode";
import { SkillDetail } from "@/pages/skills-detail";
import { SkillPublish } from "@/pages/skills-publish";

function NewSkill() {
  const [name, setName] = useState("");
  const navigate = useNavigate();
  const valid = SKILL_NAME.test(name);
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) void navigate(`${encodeURIComponent(name)}/publish`);
      }}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="new-skill">Skill name</Label>
        <Input
          id="new-skill"
          className="w-64"
          placeholder="my-skill"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <Button type="submit" size="sm" disabled={!valid}>
        Publish a skill
      </Button>
      {name !== "" && !valid && (
        <span className="text-xs text-muted-foreground">
          lowercase letters, digits and hyphens, starting with a letter, at most 64 characters
        </span>
      )}
    </form>
  );
}

function SkillList() {
  const { token } = useAuth();
  const { mode, error: modeError } = useCatalogMode();
  const skills = useQuery({
    queryKey: ["skills"],
    queryFn: ({ signal }) => listSkills(token ?? "", signal),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Skills</CardTitle>
        <CardDescription>
          Published skills at their current version. Versions are immutable; a profile uses a skill
          only when it pins an exact version.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {modeError !== undefined && <Alert variant="destructive">{modeError}</Alert>}
        {mode === "readOnly" && <ReadOnlyNote what="Skills" />}
        {mode === "manage" && <NewSkill />}
        {skills.isError && <Alert variant="destructive">{skills.error.message}</Alert>}
        {skills.isSuccess && skills.data.length === 0 && (
          <p className="text-sm">No skills published yet.</p>
        )}
        {skills.isSuccess && skills.data.length > 0 && (
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Current</Th>
                <Th>Description</Th>
                <Th>Updated</Th>
              </tr>
            </thead>
            <tbody>
              {skills.data.map((skill) => (
                <tr key={skill.name} data-testid={`skill-${skill.name}`}>
                  <Td>
                    <Link className="underline" to={encodeURIComponent(skill.name)}>
                      {skill.name}
                    </Link>
                  </Td>
                  <Td>
                    v{skill.currentVersion}{" "}
                    {skill.disableModelInvocation && (
                      <Badge variant="warning">not in model catalog</Badge>
                    )}
                  </Td>
                  <Td className="break-words">{skill.description}</Td>
                  <Td>
                    {skill.updatedAt} by {skill.updatedBy}
                  </Td>
                </tr>
              ))}
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
