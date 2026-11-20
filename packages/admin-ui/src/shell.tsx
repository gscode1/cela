import { NavLink, Outlet } from "react-router";
import { useAuth } from "@/auth";
import { Button } from "@/components/ui/button";
import { useStatusProblem } from "@/lib/use-status-rows";
import { cn } from "@/lib/utils";

/** The sidebar groups. Status is the landing page and stands alone, without a label. */
const GROUPS: readonly {
  label?: string;
  links: readonly { path: string; title: string }[];
}[] = [
  { links: [{ path: "status", title: "Status" }] },
  {
    label: "Configure",
    links: [
      { path: "profiles", title: "Profiles" },
      { path: "settings", title: "Settings" },
    ],
  },
  {
    label: "Catalog",
    links: [
      { path: "mcp-servers", title: "MCP servers" },
      { path: "skills", title: "Skills" },
      { path: "egress", title: "Egress" },
    ],
  },
  { label: "Try", links: [{ path: "playground", title: "Playground" }] },
];

export function Shell() {
  const { signOut } = useAuth();
  const problem = useStatusProblem();
  return (
    <div className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 px-4 py-6 md:flex-row">
      <aside className="flex min-w-0 shrink-0 flex-col gap-4 md:w-56">
        <h1 className="text-lg font-semibold">cela console</h1>
        {/* One scrolling row below md, grouped list from md up. */}
        <nav
          aria-label="Console"
          className="flex items-center gap-1 overflow-x-auto md:flex-col md:items-stretch md:gap-4 md:overflow-visible"
        >
          {GROUPS.map((group) => (
            <div
              key={group.label ?? "main"}
              className="flex items-center gap-1 md:flex-col md:items-stretch"
            >
              {group.label !== undefined && (
                <span className="hidden px-3 text-xs font-medium uppercase tracking-wide text-muted-foreground md:block">
                  {group.label}
                </span>
              )}
              {group.links.map((link) => (
                <NavLink
                  key={link.path}
                  to={link.path}
                  className={({ isActive }) =>
                    cn(
                      "shrink-0 whitespace-nowrap rounded-md px-3 py-2 text-sm hover:bg-muted",
                      isActive && "bg-muted font-medium",
                    )
                  }
                >
                  {link.title}
                  {link.path === "status" && problem && (
                    <span
                      role="img"
                      aria-label="Something is wrong"
                      title="Something is wrong"
                      data-testid="nav-problem"
                      className="ml-2 inline-block size-2 rounded-full bg-red-600 align-middle"
                    />
                  )}
                </NavLink>
              ))}
            </div>
          ))}
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0 justify-start text-muted-foreground md:mt-2"
            onClick={signOut}
          >
            Sign out
          </Button>
        </nav>
      </aside>
      <main className="min-w-0 flex-1">
        <Outlet />
      </main>
    </div>
  );
}
