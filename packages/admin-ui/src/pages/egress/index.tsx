import { NavLink, Route, Routes } from "react-router";
import { Alert } from "@/components/ui/alert";
import { cn } from "@/lib/utils";
import { useEgressStatusQuery } from "@/lib/queries";
import { ExplainPanel } from "@/pages/egress/explain";
import { EgressHistory } from "@/pages/egress/history";
import { RuleSetDetail } from "@/pages/egress/rule-set-detail";
import { RuleSetsPage } from "@/pages/egress/rule-sets";
import { SessionRulesPanel } from "@/pages/egress/session-rules";

/** Revision and counts of the stored rules (`GET /admin/egress/status`). */
function StatusLine() {
  const status = useEgressStatusQuery();
  if (status.isError) return <Alert variant="destructive">{status.error.message}</Alert>;
  if (!status.isSuccess) return <p className="text-sm text-muted-foreground">Loading...</p>;
  const { revision, ruleSets, rules, invalid, proxy } = status.data;
  return (
    <div className="flex flex-col gap-1 text-sm" data-testid="egress-status">
      <p>
        Rules at revision <strong>{revision}</strong>: {ruleSets}{" "}
        {ruleSets === 1 ? "rule set" : "rule sets"}, {rules} {rules === 1 ? "rule" : "rules"}.
        {invalid > 0 && (
          <span className="text-destructive">
            {" "}
            {invalid} stored {invalid === 1 ? "row is" : "rows are"} invalid and not evaluated.
          </span>
        )}
      </p>
      <p className="text-muted-foreground">
        {proxy.replicas.length === 0
          ? (proxy.note ?? "No egress proxy reports yet.")
          : proxy.replicas
              .map(
                (replica) =>
                  `${replica.name ?? "proxy"} at revision ${String(replica.revision ?? "?")}`,
              )
              .join(", ")}
      </p>
    </div>
  );
}

const TABS = [
  { to: "/egress", label: "Rule sets", end: true },
  { to: "/egress/explain", label: "Explain", end: false },
  { to: "/egress/session-rules", label: "Session rules", end: false },
  { to: "/egress/history", label: "History", end: false },
] as const;

export function EgressPage() {
  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold">Egress</h2>
      <StatusLine />
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
        <Route path="history" element={<EgressHistory />} />
        <Route path="*" element={<RuleSetsPage />} />
      </Routes>
    </div>
  );
}
