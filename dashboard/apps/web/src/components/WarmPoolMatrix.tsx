import type { WarmPoolLiveView } from "@agent-sandbox/dashboard-shared";

import { useFilters } from "../lib/filters.js";
import { cn } from "../lib/utils.js";
import { Card, CardTitle } from "./ui/card.js";

export function WarmPoolMatrix({ warmPools }: { warmPools: WarmPoolLiveView[] }) {
  const filters = useFilters();

  if (warmPools.length === 0) {
    return null;
  }

  const totalDesired = warmPools.reduce((sum, pool) => sum + pool.desiredReplicas, 0);
  const totalReady = warmPools.reduce((sum, pool) => sum + pool.readyReplicas, 0);
  const underfilled = warmPools.filter((pool) => pool.readyReplicas < pool.desiredReplicas).length;

  return (
    <Card>
      <div className="flex items-baseline justify-between gap-3">
        <CardTitle>Warm pools</CardTitle>
        <span className="text-[11px] text-slate-500 tabular-nums dark:text-slate-400">
          {totalReady}/{totalDesired}
          {underfilled > 0 ? ` · ${underfilled} short` : ""}
        </span>
      </div>
      <ul className="mt-1.5 max-h-[28rem] space-y-0.5 overflow-y-auto pr-1">
        {warmPools.map((pool) => {
          const under = pool.readyReplicas < pool.desiredReplicas;
          const failing = pool.failedReplicas > 0;
          const pct = Math.round(pool.fillRatio * 100);
          const tone = failing
            ? "text-rose-700 dark:text-rose-300"
            : under
              ? "text-amber-700 dark:text-amber-300"
              : "text-emerald-700 dark:text-emerald-300";
          const barColor = failing
            ? "bg-rose-500"
            : under
              ? "bg-amber-500"
              : "bg-emerald-500";
          return (
            <li key={`${pool.namespace}/${pool.name}`}>
              <button
                type="button"
                onClick={() =>
                  filters.focus({
                    namespace: pool.namespace,
                    resourceKind: "SandboxWarmPool",
                    resourceName: pool.name,
                  })
                }
                className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-slate-50 dark:hover:bg-slate-800"
                title={`${pool.name} · ready ${pool.readyReplicas}/${pool.desiredReplicas} · creating ${pool.creatingReplicas} · failed ${pool.failedReplicas}`}
              >
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-slate-900 dark:text-slate-100">
                  {pool.name}
                </span>
                <span className="w-12 shrink-0 overflow-hidden rounded bg-slate-100 dark:bg-slate-800">
                  <span
                    className={cn("block h-1", barColor)}
                    style={{ width: `${Math.min(100, pct)}%` }}
                    aria-hidden
                  />
                </span>
                <span className="w-10 shrink-0 text-right text-[11px] tabular-nums text-slate-600 dark:text-slate-400">
                  {pool.readyReplicas}/{pool.desiredReplicas}
                </span>
                <span className={cn("w-8 shrink-0 text-right text-[11px] tabular-nums", tone)}>
                  {pct}%
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
