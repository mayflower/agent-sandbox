import type { PendingClaimReason } from "@agent-sandbox/dashboard-shared";
import { ChevronDown, ChevronRight } from "lucide-react";

import { useFilters } from "@/lib/filters";
import { useExpandable } from "@/lib/useExpandable";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function PendingClaimsByReason({ items }: { items: PendingClaimReason[] }) {
  const filters = useFilters();
  const expandable = useExpandable();

  if (items.length === 0) {
    return null;
  }

  return (
    <Card>
      <CardHeader className="flex-row items-baseline justify-between gap-3 space-y-0 p-3 pb-2">
        <CardTitle className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Pending by reason
        </CardTitle>
        <span className="text-[11px] text-muted-foreground tabular-nums">
          {items.length} reason{items.length === 1 ? "" : "s"}
        </span>
      </CardHeader>
      <CardContent className="p-3 pt-0">
        <ul className="max-h-[18rem] space-y-1 overflow-y-auto pr-1">
          {items.map((entry) => {
            const key = entry.reason;
            const open = expandable.has(key);
            return (
              <li key={key} className="rounded-md border border-border bg-card">
                <button
                  type="button"
                  onClick={() => expandable.toggle(key)}
                  className="flex w-full items-center justify-between gap-2 px-2 py-1 text-left hover:bg-accent hover:text-accent-foreground"
                  aria-expanded={open}
                >
                  <span className="truncate text-xs">{entry.reason}</span>
                  <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
                    <span className="tabular-nums">{entry.count}</span>
                    {open ? (
                      <ChevronDown className="h-3 w-3" aria-hidden />
                    ) : (
                      <ChevronRight className="h-3 w-3" aria-hidden />
                    )}
                  </span>
                </button>
                {open && (
                  <ul className="border-t border-border bg-muted/30 py-1 text-xs">
                    {entry.claims.map((claim) => (
                      <li key={`${claim.namespace}/${claim.name}`}>
                        <button
                          type="button"
                          onClick={() =>
                            filters.focus({
                              namespace: claim.namespace,
                              resourceKind: "SandboxClaim",
                              resourceName: claim.name,
                            })
                          }
                          className="flex w-full items-center justify-between gap-2 px-2 py-0.5 text-left hover:bg-accent hover:text-accent-foreground"
                        >
                          <span className="truncate font-mono">
                            <span className="text-muted-foreground">{claim.namespace}</span>
                            <span className="mx-0.5 text-muted-foreground">/</span>
                            <span>{claim.name}</span>
                          </span>
                          <span className="text-[10px] text-muted-foreground">open</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
