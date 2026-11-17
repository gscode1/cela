import { Navigate, Route, Routes } from "react-router";
import { useAuth } from "@/auth";
import { GlobalSettings } from "@/pages/settings";
import { McpServersPage } from "@/pages/mcp";
import { Placeholder } from "@/pages/placeholder";
import { Profiles } from "@/pages/profiles";
import { SignIn } from "@/pages/sign-in";
import { SkillsRoutes } from "@/pages/skills";
import { ShardStatusPage } from "@/pages/status";
import { SECTIONS, Shell } from "@/shell";

/** Sections that have their own screen; the others still show the placeholder. */
const BUILT = new Set(["settings", "profiles", "mcp-servers", "skills", "status"]);

/**
 * Routes live under the router's `/console` basename. Signed out, every route shows the sign-in screen and keeps the
 * address, so a direct link such as `/console/profiles` opens that screen right after sign-in.
 */
export function App() {
  const { token } = useAuth();
  if (token === undefined) return <SignIn />;
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<Navigate to="settings" replace />} />
        <Route path="settings" element={<GlobalSettings />} />
        <Route path="profiles/*" element={<Profiles />} />
        <Route path="mcp-servers/*" element={<McpServersPage />} />
        <Route path="skills/*" element={<SkillsRoutes />} />
        <Route path="status/*" element={<ShardStatusPage />} />
        {SECTIONS.filter((section) => !BUILT.has(section.path)).map((section) => (
          <Route
            key={section.path}
            path={`${section.path}/*`}
            element={<Placeholder title={section.title} />}
          />
        ))}
        <Route path="*" element={<Placeholder title="Not found" />} />
      </Route>
    </Routes>
  );
}
