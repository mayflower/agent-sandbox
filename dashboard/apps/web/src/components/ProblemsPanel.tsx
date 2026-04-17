import { groupProblems, type ProblemGroup, type ProblemView } from "@agent-sandbox/dashboard-shared";
import { useMemo, useState } from "react";

import { useFilters } from "../lib/filters.js";
import { Badge } from "./ui/badge.js";
import { Card, CardTitle } from "./ui/card.js";

function toneForSeverity(severity: ProblemView["severity"]) {
  switch (severity) {
    case "error":
      return "danger" as const;
    case "warning":
      return "warning" as const;
    default:
      return "info" as const;
  }
}

function matchesFilters(problem: ProblemView, search: string, namespace: string): boolean {
  if (namespace && problem.namespace !== namespace) return false;
  if (!search) return true;
  const needle = search.toLowerCase();
  return (
    problem.resourceName.toLowerCase().includes(needle) ||
    problem.namespace.toLowerCase().includes(needle)
  );
}

export function ProblemsPanel({ problems }: { problems: ProblemView[] }) {
  const filters = useFilters();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const filtered = useMemo(
    () => problems.filter((problem) => matchesFilters(problem, filters.search, filters.namespace)),
    [problems, filters.search, filters.namespace],
  );
  const groups = useMemo(() => groupProblems(filtered), [filtered]);
  const errorCount = filtered.filter((problem) => problem.severity === "error").length;
  const warningCount = filtered.filter((problem) => problem.severity === "warning").length;

  const toggle = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <Card>
      <div className="flex items-center justify-between gap-3">
        <CardTitle>Problems</CardTitle>
        <Badge tone={filtered.length > 0 ? "warning" : "success"}>
          {filtered.length === 0
            ? "all clear"
            : `${errorCount} error${errorCount === 1 ? "" : "s"} · ${warningCount} warning${warningCount === 1 ? "" : "s"}`}
        </Badge>
      </div>
      <div className="mt-4 space-y-3">
        {groups.length === 0 ? (
          <p className="text-sm text-stone-600">No matching problems.</p>
        ) : (
          groups.map((group) => (
            <ProblemGroupCard
              key={group.kind}
              group={group}
              expanded={expanded.has(group.kind)}
              onToggle={() => toggle(group.kind)}
              onItemClick={(item) =>
                filters.focus({
                  namespace: item.namespace,
                  resourceKind: item.resourceKind,
                  resourceName: item.resourceName,
                })
              }
            />
          ))
        )}
      </div>
    </Card>
  );
}

function ProblemGroupCard({
  group,
  expanded,
  onToggle,
  onItemClick,
}: {
  group: ProblemGroup;
  expanded: boolean;
  onToggle: () => void;
  onItemClick: (item: ProblemView) => void;
}) {
  return (
    <article className="rounded-2xl border border-stone-200 bg-white/70">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-start gap-3 p-3 text-left hover:bg-emerald-50/60"
        aria-expanded={expanded}
      >
        <Badge tone={toneForSeverity(group.severity)}>{group.severity}</Badge>
        <div className="flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-sm font-semibold text-stone-800">{group.summary}</span>
            <span className="text-xs text-stone-500">{expanded ? "hide" : "show"}</span>
          </div>
          <p className="mt-0.5 text-xs text-stone-500">
            {group.count} affected · {group.items[0]?.resourceKind}
          </p>
        </div>
        <Badge tone="neutral">{group.count}</Badge>
      </button>
      {expanded && (
        <ul className="border-t border-stone-200 bg-canvas/40 px-3 py-2 text-sm text-stone-700">
          {group.items.map((item) => (
            <li key={`${item.namespace}/${item.resourceName}`}>
              <button
                type="button"
                onClick={() => onItemClick(item)}
                className="flex w-full items-center justify-between gap-3 rounded-lg px-2 py-1 text-left hover:bg-white"
              >
                <span className="truncate">
                  <span className="text-stone-500">{item.namespace}</span>
                  <span className="mx-1 text-stone-400">/</span>
                  <span>{item.resourceName}</span>
                </span>
                <span className="text-xs text-stone-400">open</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
