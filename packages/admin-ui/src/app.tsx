import { Navigate, Route, Routes } from "react-router";
import { useAuth } from "@/auth";
import { EgressPage } from "@/pages/egress";
import { GlobalSettings } from "@/pages/settings";
import { McpServersPage } from "@/pages/mcp";
import { NotFound } from "@/pages/not-found";
import { PlaygroundPage } from "@/pages/playground";
import { Profiles } from "@/pages/profiles";
import { SignIn } from "@/pages/sign-in";
import { SkillsRoutes } from "@/pages/skills";
import { ShardStatusPage } from "@/pages/status";
import { Shell } from "@/shell";

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
        <Route index element={<Navigate to="status" replace />} />
        <Route path="settings" element={<GlobalSettings />} />
        <Route path="profiles/*" element={<Profiles />} />
        <Route path="mcp-servers/*" element={<McpServersPage />} />
        <Route path="skills/*" element={<SkillsRoutes />} />
        <Route path="egress/*" element={<EgressPage />} />
        <Route path="status/*" element={<ShardStatusPage />} />
        <Route path="playground" element={<PlaygroundPage />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
