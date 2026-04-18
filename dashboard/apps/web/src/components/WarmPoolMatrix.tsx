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
      <div className="mt-1.5 max-h-[28rem] overflow-auto">
        <table className="min-w-full text-xs">
          <thead className="sticky top-0 z-10 bg-white dark:bg-slate-900">
            <tr className="text-left text-[10px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              <th className="px-1.5 py-1">Pool</th>
              <th className="px-1.5 py-1">Template</th>
              <th className="px-1.5 py-1 text-right">Rdy</th>
              <th className="px-1.5 py-1 text-right">Des</th>
              <th className="px-1.5 py-1 text-right">Crt</th>
              <th className="px-1.5 py-1 text-right">Fail</th>
              <th className="px-1.5 py-1 text-right">Fill</th>
            </tr>
          </thead>
          <tbody>
            {warmPools.map((pool) => {
              const under = pool.readyReplicas < pool.desiredReplicas;
              const failing = pool.failedReplicas > 0;
              return (
                <tr
                  key={`${pool.namespace}/${pool.name}`}
                  onClick={() =>
                    filters.focus({
                      namespace: pool.namespace,
                      resourceKind: "SandboxWarmPool",
                      resourceName: pool.name,
                    })
                  }
                  className={cn(
                    "cursor-pointer border-t border-slate-100 tabular-nums hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800",
                    failing && "bg-rose-50/60 dark:bg-rose-900/20",
                    !failing && under && "bg-amber-50/50 dark:bg-amber-900/20",
                  )}
                >
                  <td
                    className="max-w-[10rem] truncate px-1.5 py-0.5 font-mono text-slate-900 dark:text-slate-100"
                    title={pool.name}
                  >
                    {pool.name}
                  </td>
                  <td
                    className="max-w-[10rem] truncate px-1.5 py-0.5 text-slate-600 dark:text-slate-400"
                    title={pool.templateRef}
                  >
                    {pool.templateRef}
                  </td>
                  <td className="px-1.5 py-0.5 text-right text-slate-800 dark:text-slate-200">
                    {pool.readyReplicas}
                  </td>
                  <td className="px-1.5 py-0.5 text-right text-slate-800 dark:text-slate-200">
                    {pool.desiredReplicas}
                  </td>
                  <td className="px-1.5 py-0.5 text-right text-slate-800 dark:text-slate-200">
                    {pool.creatingReplicas}
                  </td>
                  <td
                    className={cn(
                      "px-1.5 py-0.5 text-right",
                      failing ? "text-rose-700 dark:text-rose-300" : "text-slate-800 dark:text-slate-200",
                    )}
                  >
                    {pool.failedReplicas}
                  </td>
                  <td
                    className={cn(
                      "px-1.5 py-0.5 text-right",
                      under ? "text-amber-700 dark:text-amber-300" : "text-emerald-700 dark:text-emerald-300",
                    )}
                  >
                    {Math.round(pool.fillRatio * 100)}%
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
