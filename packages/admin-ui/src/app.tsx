import { Navigate, Route, Routes } from "react-router";
import { useAuth } from "@/auth";
import { GlobalSettings } from "@/pages/settings";
import { Placeholder } from "@/pages/placeholder";
import { SignIn } from "@/pages/sign-in";
import { SECTIONS, Shell } from "@/shell";

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
        {SECTIONS.filter((section) => section.path !== "settings").map((section) => (
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
