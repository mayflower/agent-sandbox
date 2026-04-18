import { groupProblems, type ProblemGroup, type ProblemView } from "@agent-sandbox/dashboard-shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { api } from "../lib/api.js";
import { useFilters } from "../lib/filters.js";
import { useExpandable } from "../lib/useExpandable.js";
import { cn, matchesSearch } from "../lib/utils.js";
import { ActionButton } from "./ActionButton.js";
import { Card, CardTitle } from "./ui/card.js";

const SEVERITY_DOT: Record<ProblemView["severity"], string> = {
  error: "bg-rose-500",
  warning: "bg-amber-500",
  info: "bg-sky-500",
};

export function ProblemsPanel({ problems }: { problems: ProblemView[] }) {
  const filters = useFilters();
  const expandable = useExpandable();

  const filtered = useMemo(
    () =>
      problems.filter(
        (problem) =>
          matchesSearch(problem.resourceName, problem.namespace, filters.search) &&
          (!filters.namespace || problem.namespace === filters.namespace),
      ),
    [problems, filters.search, filters.namespace],
  );
  const groups = useMemo(() => groupProblems(filtered), [filtered]);

  return (
    <Card aria-label="Problems" role="region">
      <div className="flex items-center justify-between gap-3">
        <CardTitle>Problems</CardTitle>
        <span className="text-[11px] text-slate-500 tabular-nums dark:text-slate-400">
          {filtered.length === 0 ? "all clear" : `${groups.length} group${groups.length === 1 ? "" : "s"}`}
        </span>
      </div>
      <div className="mt-2 max-h-[32rem] space-y-1.5 overflow-y-auto pr-1" aria-live="polite">
        {groups.length === 0 ? (
          <p className="text-xs text-slate-500 dark:text-slate-400">No matching problems.</p>
        ) : (
          groups.map((group) => (
            <ProblemGroupCard
              key={group.kind}
              group={group}
              expanded={expandable.has(group.kind)}
              onToggle={() => expandable.toggle(group.kind)}
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
  const queryClient = useQueryClient();
  const cleanup = useMutation({
    mutationFn: () => api.cleanupOrphans(),
    onSuccess: () => queryClient.invalidateQueries(),
  });
  return (
    <article className="rounded border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800"
        aria-expanded={expanded}
      >
        <span className={cn("h-1.5 w-1.5 rounded-full", SEVERITY_DOT[group.severity])} aria-hidden />
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="truncate text-xs font-medium text-slate-800 dark:text-slate-200">
            {group.summary}
          </span>
          <span className="text-[11px] text-slate-500 dark:text-slate-400">{group.items[0]?.resourceKind}</span>
        </div>
        <span className="text-[11px] tabular-nums text-slate-600 dark:text-slate-300">{group.count}</span>
        <span className="text-[11px] text-slate-400">{expanded ? "−" : "+"}</span>
      </button>
      {group.kind === "runtime-missing" && (
        <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 px-2 py-1.5 dark:border-slate-800">
          <ActionButton
            label={`Delete ${group.count} orphaned sandbox${group.count === 1 ? "" : "es"}`}
            confirmLabel="Confirm bulk delete"
            tone="danger"
            pending={cleanup.isPending}
            onConfirm={() => cleanup.mutateAsync()}
          />
          {cleanup.data && (
            <span className="text-[11px] text-slate-600 dark:text-slate-400">
              Deleted {cleanup.data.results.filter((result) => result.ok).length} of {cleanup.data.attempted}.
            </span>
          )}
        </div>
      )}
      {expanded && (
        <ul className="border-t border-slate-200 bg-slate-50 py-1 text-xs text-slate-700 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-300">
          {group.items.map((item) => (
            <li key={`${item.namespace}/${item.resourceName}`}>
              <button
                type="button"
                onClick={() => onItemClick(item)}
                className="flex w-full items-center justify-between gap-2 px-2 py-0.5 text-left hover:bg-white dark:hover:bg-slate-900"
              >
                <span className="truncate font-mono">
                  <span className="text-slate-500 dark:text-slate-500">{item.namespace}</span>
                  <span className="mx-0.5 text-slate-400">/</span>
                  <span>{item.resourceName}</span>
                </span>
                <span className="text-[10px] text-slate-400">open</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
