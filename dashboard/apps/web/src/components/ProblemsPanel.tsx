import type { ProblemView } from "@agent-sandbox/dashboard-shared";

import { Badge } from "./ui/badge.js";
import { Card, CardTitle } from "./ui/card.js";

function toneForSeverity(severity: ProblemView["severity"]) {
  switch (severity) {
    case "error":
      return "danger";
    case "warning":
      return "warning";
    default:
      return "info";
  }
}

export function ProblemsPanel({ problems }: { problems: ProblemView[] }) {
  return (
    <Card>
      <div className="flex items-center justify-between gap-3">
        <CardTitle>Problems</CardTitle>
        <Badge tone={problems.length > 0 ? "warning" : "success"}>{problems.length} active</Badge>
      </div>
      <div className="mt-4 space-y-3">
        {problems.length === 0 ? (
          <p className="text-sm text-stone-600">No active issues in the live snapshot.</p>
        ) : (
          problems.map((problem) => (
            <article key={`${problem.kind}-${problem.namespace}-${problem.resourceName}`} className="rounded-2xl border border-stone-200 bg-white/70 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={toneForSeverity(problem.severity)}>{problem.severity}</Badge>
                <span className="text-sm font-semibold text-stone-800">{problem.resourceKind} {problem.resourceName}</span>
              </div>
              <p className="mt-2 text-sm text-stone-700">{problem.summary}</p>
            </article>
          ))
        )}
      </div>
    </Card>
  );
}
