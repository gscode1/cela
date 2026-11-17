import { NavLink, Outlet } from "react-router";
import { useAuth } from "@/auth";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const SECTIONS = [
  { path: "settings", title: "Global settings" },
  { path: "profiles", title: "Session profiles" },
  { path: "mcp-servers", title: "MCP servers" },
  { path: "skills", title: "Skills" },
  { path: "status", title: "Shard status" },
] as const;

export function Shell() {
  const { signOut } = useAuth();
  return (
    <div className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 px-4 py-6 md:flex-row">
      <aside className="flex shrink-0 flex-col gap-4 md:w-56">
        <h1 className="text-lg font-semibold">pi-durable console</h1>
        <nav aria-label="Console" className="flex flex-col gap-1">
          {SECTIONS.map((section) => (
            <NavLink
              key={section.path}
              to={section.path}
              className={({ isActive }) =>
                cn(
                  "rounded-md px-3 py-2 text-sm hover:bg-muted",
                  isActive && "bg-muted font-medium",
                )
              }
            >
              {section.title}
            </NavLink>
          ))}
        </nav>
        <Button variant="outline" size="sm" onClick={signOut}>
          Sign out
        </Button>
      </aside>
      <main className="min-w-0 flex-1">
        <Outlet />
      </main>
    </div>
  );
}
