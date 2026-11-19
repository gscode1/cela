import { NavLink, Route, Routes } from "react-router";
import { cn } from "@/lib/utils";
import { ExplainPanel } from "@/pages/egress/explain";
import { RuleSetDetail } from "@/pages/egress/rule-set-detail";
import { RuleSetsPage } from "@/pages/egress/rule-sets";
import { SessionRulesPanel } from "@/pages/egress/session-rules";

const TABS = [
  { to: "/egress", label: "Rule sets", end: true },
  { to: "/egress/explain", label: "Explain", end: false },
  { to: "/egress/session-rules", label: "Session rules", end: false },
] as const;

export function EgressPage() {
  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold">Egress</h2>
      <nav aria-label="Egress sections" className="flex flex-wrap gap-1 border-b">
        {TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.end}
            className={({ isActive }) =>
              cn(
                "rounded-t-md px-3 py-2 text-sm hover:bg-muted",
                isActive && "border-b-2 border-primary font-medium",
              )
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>
      <Routes>
        <Route index element={<RuleSetsPage />} />
        <Route path="sets/:name" element={<RuleSetDetail />} />
        <Route path="explain" element={<ExplainPanel />} />
        <Route path="session-rules" element={<SessionRulesPanel />} />
        <Route path="*" element={<RuleSetsPage />} />
      </Routes>
    </div>
  );
}
