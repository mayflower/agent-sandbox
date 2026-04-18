import { groupProblems, type ProblemGroup, type ProblemView } from "@agent-sandbox/dashboard-shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useMemo } from "react";

import { api } from "@/lib/api";
import { useFilters } from "@/lib/filters";
import { useExpandable } from "@/lib/useExpandable";
import { matchesSearch } from "@/lib/utils";
import { ActionButton } from "@/components/ActionButton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

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
      <CardHeader className="flex-row items-baseline justify-between gap-3 space-y-0 p-3 pb-2">
        <CardTitle className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Problems
        </CardTitle>
        <span className="text-[11px] text-muted-foreground tabular-nums">
          {filtered.length === 0 ? "all clear" : `${groups.length} group${groups.length === 1 ? "" : "s"}`}
        </span>
      </CardHeader>
      <CardContent className="space-y-1 p-3 pt-0" aria-live="polite">
        {groups.length === 0 ? (
          <p className="text-xs text-muted-foreground">No matching problems.</p>
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
      </CardContent>
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
    <article className="rounded-md border border-border bg-card">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-accent hover:text-accent-foreground"
        aria-expanded={expanded}
      >
        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", SEVERITY_DOT[group.severity])} aria-hidden />
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="truncate text-xs font-medium">{group.summary}</span>
          <span className="shrink-0 text-[11px] text-muted-foreground">{group.items[0]?.resourceKind}</span>
        </div>
        <span className="text-[11px] tabular-nums text-muted-foreground">{group.count}</span>
        {expanded ? (
          <ChevronDown className="h-3 w-3 text-muted-foreground" aria-hidden />
        ) : (
          <ChevronRight className="h-3 w-3 text-muted-foreground" aria-hidden />
        )}
      </button>
      {group.kind === "runtime-missing" && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border px-2 py-1.5">
          <ActionButton
            label={`Delete ${group.count} orphaned sandbox${group.count === 1 ? "" : "es"}`}
            confirmLabel="Confirm bulk delete"
            tone="danger"
            pending={cleanup.isPending}
            onConfirm={() => cleanup.mutateAsync()}
          />
          {cleanup.data && (
            <span className="text-[11px] text-muted-foreground">
              Deleted {cleanup.data.results.filter((result) => result.ok).length} of {cleanup.data.attempted}.
            </span>
          )}
        </div>
      )}
      {expanded && (
        <ul className="border-t border-border bg-muted/30 py-1 text-xs">
          {group.items.map((item) => (
            <li key={`${item.namespace}/${item.resourceName}`}>
              <button
                type="button"
                onClick={() => onItemClick(item)}
                className="flex w-full items-center justify-between gap-2 px-2 py-0.5 text-left hover:bg-accent hover:text-accent-foreground"
              >
                <span className="truncate font-mono">
                  <span className="text-muted-foreground">{item.namespace}</span>
                  <span className="mx-0.5 text-muted-foreground">/</span>
                  <span>{item.resourceName}</span>
                </span>
                <span className="text-[10px] text-muted-foreground">open</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
