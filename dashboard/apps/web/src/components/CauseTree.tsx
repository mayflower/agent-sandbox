import type { ProblemDag, ProblemNode, SandboxResourceKind } from "@agent-sandbox/dashboard-shared";
import { ChevronDown, ChevronRight, AlertCircle, AlertTriangle, Info } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { useFilters } from "@/lib/filters";
import { cn } from "@/lib/utils";
import { ProblemEducation } from "./ProblemEducation";

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

export interface CauseTreeProps {
  dag: ProblemDag;
  acks?: Set<string>;
  onAck?(kind: string): void;
}

function childrenOf(dag: ProblemDag, parentId: string): ProblemNode[] {
  return Object.values(dag.byId).filter((node) => node.parentId === parentId);
}

export function CauseTree({ dag, acks, onAck }: CauseTreeProps) {
  if (dag.roots.length === 0) {
    return <p className="text-sm text-muted-foreground">No problems detected.</p>;
  }
  return (
    <ul className="space-y-2">
      {dag.roots
        .filter((id) => !acks?.has(dag.byId[id]!.kind))
        .map((rootId) => {
          const node = dag.byId[rootId];
          if (!node) return null;
          return (
            <TreeNode
              key={rootId}
              node={node}
              dag={dag}
              depth={0}
              acked={acks?.has(node.kind) ?? false}
              {...(onAck ? { onAck } : {})}
            />
          );
        })}
    </ul>
  );
}

function TreeNode({
  node,
  dag,
  depth,
  acked,
  onAck,
}: {
  node: ProblemNode;
  dag: ProblemDag;
  depth: number;
  acked: boolean;
  onAck?(kind: string): void;
}) {
  const filters = useFilters();
  const expanded = filters.expandedProblems.has(node.id);
  const children = childrenOf(dag, node.id);
  const Icon = SEVERITY_ICONS[node.severity];

  return (
    <li className={cn("rounded border bg-card p-2", depth > 0 && "ml-4 border-l-2")}>
      <div className="flex items-start gap-2">
        <button
          type="button"
          className="mt-0.5"
          onClick={() => filters.toggleExpandedProblem(node.id)}
          aria-label={expanded ? "Collapse" : "Expand"}
        >
          {(children.length > 0 || node.affectedResources.length > 0) &&
            (expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />)}
        </button>
        <Icon
          className={cn(
            "mt-0.5 h-3.5 w-3.5",
            node.severity === "error" && "text-rose-500",
            node.severity === "warning" && "text-amber-500",
            node.severity === "info" && "text-sky-500",
          )}
        />
        <div className="flex-1 space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span className={cn("text-sm font-medium", acked && "line-through text-muted-foreground")}>
              {node.summary}
            </span>
            <div className="flex items-center gap-1">
              <Badge tone={SEVERITY_TONE[node.severity]}>{node.affectedResources.length}</Badge>
              {onAck && !acked && (
                <button
                  type="button"
                  className="text-[10px] text-muted-foreground hover:underline"
                  onClick={() => onAck(node.kind)}
                >
                  ack 1h
                </button>
              )}
            </div>
          </div>
          {expanded && (
            <div className="space-y-1">
              <ul className="space-y-0.5 text-xs">
                {node.affectedResources.map((resource) => (
                  <li
                    key={`${resource.namespace}/${resource.resourceName}`}
                    className="cursor-pointer text-muted-foreground hover:text-foreground"
                    onClick={() =>
                      filters.focus({
                        namespace: resource.namespace,
                        resourceKind: resource.resourceKind as SandboxResourceKind,
                        resourceName: resource.resourceName,
                      })
                    }
                  >
                    {resource.namespace}/{resource.resourceName}
                  </li>
                ))}
              </ul>
              <ProblemEducation kind={node.kind} />
            </div>
          )}
          {children.length > 0 && expanded && (
            <ul className="space-y-2 pt-1">
              {children.map((child) => (
                <TreeNode
                  key={child.id}
                  node={child}
                  dag={dag}
                  depth={depth + 1}
                  acked={false}
                  {...(onAck ? { onAck } : {})}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </li>
  );
}
