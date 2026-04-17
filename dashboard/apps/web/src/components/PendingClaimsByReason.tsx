import type { PendingClaimReason } from "@agent-sandbox/dashboard-shared";
import { useState } from "react";

import { useFilters } from "../lib/filters.js";
import { Badge } from "./ui/badge.js";
import { Card, CardTitle } from "./ui/card.js";

export function PendingClaimsByReason({ items }: { items: PendingClaimReason[] }) {
  const filters = useFilters();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  if (items.length === 0) {
    return null;
  }

  const toggle = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const total = items.reduce((sum, entry) => sum + entry.count, 0);

  return (
    <Card>
      <div className="flex items-baseline justify-between gap-3">
        <CardTitle>Pending claims</CardTitle>
        <Badge tone={total > 0 ? "warning" : "success"}>{total} pending</Badge>
      </div>
      <ul className="mt-3 space-y-2">
        {items.map((entry) => {
          const key = entry.reason;
          const open = expanded.has(key);
          return (
            <li key={key} className="rounded-2xl border border-stone-200 bg-white/70">
              <button
                type="button"
                onClick={() => toggle(key)}
                className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-emerald-50/60"
                aria-expanded={open}
              >
                <span className="text-sm font-semibold text-stone-800">{entry.reason}</span>
                <div className="flex items-center gap-2 text-xs text-stone-500">
                  <span>{open ? "hide" : "show"}</span>
                  <Badge tone="neutral">{entry.count}</Badge>
                </div>
              </button>
              {open && (
                <ul className="border-t border-stone-200 bg-canvas/40 px-3 py-2 text-sm text-stone-700">
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
                        className="flex w-full items-center justify-between gap-3 rounded-lg px-2 py-1 text-left hover:bg-white"
                      >
                        <span className="truncate">
                          <span className="text-stone-500">{claim.namespace}</span>
                          <span className="mx-1 text-stone-400">/</span>
                          <span>{claim.name}</span>
                        </span>
                        <span className="text-xs text-stone-400">open</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
