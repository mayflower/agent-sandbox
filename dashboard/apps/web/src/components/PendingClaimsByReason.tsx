import type { PendingClaimReason } from "@agent-sandbox/dashboard-shared";

import { useFilters } from "../lib/filters.js";
import { useExpandable } from "../lib/useExpandable.js";
import { Card, CardTitle } from "./ui/card.js";

export function PendingClaimsByReason({ items }: { items: PendingClaimReason[] }) {
  const filters = useFilters();
  const expandable = useExpandable();

  if (items.length === 0) {
    return null;
  }

  return (
    <Card>
      <div className="flex items-baseline justify-between gap-3">
        <CardTitle>Pending by reason</CardTitle>
        <span className="text-[11px] text-slate-500 tabular-nums dark:text-slate-400">{items.length} reason{items.length === 1 ? "" : "s"}</span>
      </div>
      <ul className="mt-1.5 max-h-[18rem] space-y-1 overflow-y-auto pr-1">
        {items.map((entry) => {
          const key = entry.reason;
          const open = expandable.has(key);
          return (
            <li
              key={key}
              className="rounded border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"
            >
              <button
                type="button"
                onClick={() => expandable.toggle(key)}
                className="flex w-full items-center justify-between gap-2 px-2 py-1 text-left hover:bg-slate-50 dark:hover:bg-slate-800"
                aria-expanded={open}
              >
                <span className="truncate text-xs text-slate-800 dark:text-slate-200">{entry.reason}</span>
                <span className="flex items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400">
                  <span className="tabular-nums">{entry.count}</span>
                  <span>{open ? "−" : "+"}</span>
                </span>
              </button>
              {open && (
                <ul className="border-t border-slate-200 bg-slate-50 py-1 text-xs text-slate-700 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-300">
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
                        className="flex w-full items-center justify-between gap-2 px-2 py-0.5 text-left hover:bg-white dark:hover:bg-slate-900"
                      >
                        <span className="truncate font-mono">
                          <span className="text-slate-500 dark:text-slate-500">{claim.namespace}</span>
                          <span className="mx-0.5 text-slate-400">/</span>
                          <span>{claim.name}</span>
                        </span>
                        <span className="text-[10px] text-slate-400">open</span>
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
