import type { ProblemDag, ProblemNode, SandboxResourceKind } from "@agent-sandbox/dashboard-shared";
import { lookupProblemDoc } from "@agent-sandbox/dashboard-shared";
import { ChevronDown, ChevronRight, AlertCircle, AlertTriangle, Info } from "lucide-react";

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
    return <p className="text-xs text-muted-foreground">No problems detected.</p>;
  }
  return (
    <ul className="divide-y divide-border/40">
      {dag.roots
        .map((rootId) => dag.byId[rootId])
        .filter((node): node is NonNullable<typeof node> => node !== undefined)
        .filter((node) => !acks?.has(node.kind))
        .map((node) => (
          <TreeNode
            key={node.id}
            node={node}
            dag={dag}
            depth={0}
            acked={acks?.has(node.kind) ?? false}
            {...(onAck ? { onAck } : {})}
          />
        ))}
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
  const doc = lookupProblemDoc(node.kind);
  const canExpand = children.length > 0 || node.affectedResources.length > 0 || doc !== undefined;

  return (
    <li className={cn("py-1.5", depth > 0 && "border-l border-border/40 pl-3")}>
      <div className="flex items-start gap-1.5">
        <button
          type="button"
          className="mt-0.5 inline-flex h-3 w-3 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
          onClick={() => canExpand && filters.toggleExpandedProblem(node.id)}
          aria-label={expanded ? "Collapse" : "Expand"}
          disabled={!canExpand}
        >
          {canExpand ? (
            expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />
          ) : null}
        </button>
        <Icon
          className={cn(
            "mt-0.5 h-3 w-3 shrink-0",
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
          {expanded && (
            <div className="mt-1 space-y-1.5">
              {node.affectedResources.length > 0 && (
                <ul className="space-y-0.5">
                  {node.affectedResources.map((resource) => (
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
                        {resource.namespace}/{resource.resourceName}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {doc && (
                <div className="space-y-1 rounded bg-muted/40 px-2 py-1.5 text-[11px]">
                  <div className="font-semibold">{doc.title}</div>
                  <p className="text-muted-foreground">{doc.explanation}</p>
                  {doc.firstChecks.length > 0 && (
                    <ul className="list-disc space-y-0.5 pl-3 text-muted-foreground">
                      {doc.firstChecks.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              {children.length > 0 && (
                <ul className="space-y-1">
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
          )}
        </div>
      </div>
    </li>
  );
}
