import type { ProblemDag, ProblemNode, SandboxResourceKind } from "@agent-sandbox/dashboard-shared";
import { lookupProblemDoc } from "@agent-sandbox/dashboard-shared";
import { ChevronDown, ChevronRight, AlertCircle, AlertTriangle, ArrowUpRight, Info } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { useFilters } from "@/lib/filters";
import { cn } from "@/lib/utils";

const SEVERITY_ICONS = {
  error: AlertCircle,
  warning: AlertTriangle,
  info: Info,
} as const;

const SEVERITY_TONE = {
  error: "danger",
  warning: "warning",
  info: "info",
} as const;

const SEVERITY_RANK = { error: 0, warning: 1, info: 2 } as const;

export interface CauseTreeProps {
  dag: ProblemDag;
  acks?: Set<string>;
  onAck?(kind: string): void;
}

export function CauseTree({ dag, acks, onAck }: CauseTreeProps) {
  // Flatten the DAG to a single severity-sorted list. The cause/effect link
  // is preserved as a tiny "via <parent>" caption inside the child row, so
  // operators see every problem at one indent and don't have to chase
  // through nested expansions.
  const visible = Object.values(dag.byId)
    .filter((node) => !acks?.has(node.kind))
    .sort((a, b) => {
      const sev = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
      if (sev !== 0) return sev;
      return b.affectedResources.length - a.affectedResources.length;
    });

  if (visible.length === 0) {
    return <p className="text-xs text-muted-foreground">No problems detected.</p>;
  }

  return (
    <ul className="divide-y divide-border/40">
      {visible.map((node) => (
        <ProblemRow
          key={node.id}
          node={node}
          parent={node.parentId ? dag.byId[node.parentId] : undefined}
          acked={acks?.has(node.kind) ?? false}
          {...(onAck ? { onAck } : {})}
        />
      ))}
    </ul>
  );
}

function ProblemRow({
  node,
  parent,
  acked,
  onAck,
}: {
  node: ProblemNode;
  parent: ProblemNode | undefined;
  acked: boolean;
  onAck?(kind: string): void;
}) {
  const filters = useFilters();
  const expanded = filters.expandedProblems.has(node.id);
  const Icon = SEVERITY_ICONS[node.severity];
  const doc = lookupProblemDoc(node.kind);
  const visibleResources = node.affectedResources.slice(0, 6);
  const remainingResources = node.affectedResources.length - visibleResources.length;

  return (
    <li className="py-1.5">
      <div className="flex items-start gap-1.5">
        <button
          type="button"
          className="mt-1 inline-flex h-3 w-3 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
          onClick={() => filters.toggleExpandedProblem(node.id)}
          aria-label={expanded ? "Collapse" : "Expand"}
        >
          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        </button>
        <Icon
          className={cn(
            "mt-1 h-3 w-3 shrink-0",
            node.severity === "error" && "text-rose-500",
            node.severity === "warning" && "text-amber-500",
            node.severity === "info" && "text-sky-500",
          )}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className={cn("text-xs leading-snug", acked && "text-muted-foreground line-through")}>
              {node.summary}
            </span>
            <div className="flex shrink-0 items-center gap-1">
              <Badge tone={SEVERITY_TONE[node.severity]}>{node.affectedResources.length}</Badge>
              {onAck && !acked && (
                <button
                  type="button"
                  className="text-[10px] text-muted-foreground hover:text-foreground hover:underline"
                  onClick={() => onAck(node.kind)}
                >
                  ack 1h
                </button>
              )}
            </div>
          </div>
          {parent && (
            <div className="mt-0.5 text-[10px] text-muted-foreground">
              via <span className="font-mono">{parent.kind}</span>
            </div>
          )}
          {expanded && (
            <div className="mt-1.5 space-y-1.5">
              {visibleResources.length > 0 && (
                <ul className="space-y-0.5">
                  {visibleResources.map((resource) => (
                    <li key={`${resource.namespace}/${resource.resourceName}`}>
                      <button
                        type="button"
                        className="block w-full truncate text-left font-mono text-[11px] text-muted-foreground hover:text-foreground"
                        title={`${resource.namespace}/${resource.resourceName}`}
                        onClick={() =>
                          filters.focus({
                            namespace: resource.namespace,
                            resourceKind: resource.resourceKind as SandboxResourceKind,
                            resourceName: resource.resourceName,
                          })
                        }
                      >
                        <ArrowUpRight className="mr-1 inline h-2.5 w-2.5" aria-hidden />
                        {resource.namespace}/{resource.resourceName}
                      </button>
                    </li>
                  ))}
                  {remainingResources > 0 && (
                    <li className="text-[10px] text-muted-foreground">
                      … and {remainingResources} more
                    </li>
                  )}
                </ul>
              )}
              {doc && (
                <div className="rounded bg-muted/40 px-2 py-1.5 text-[11px] leading-snug">
                  <div className="mb-0.5 font-semibold">{doc.title}</div>
                  <p className="text-muted-foreground">{doc.explanation}</p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}
