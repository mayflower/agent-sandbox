import type { WarmPoolLiveView } from "@agent-sandbox/dashboard-shared";

import { useFilters } from "../lib/filters.js";
import { Badge } from "./ui/badge.js";
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
        <span className="text-xs text-slate-500 tabular-nums">
          {totalReady}/{totalDesired} ready · {underfilled > 0 ? `${underfilled} underfilled` : "all filled"}
        </span>
      </div>
      <div className="mt-2 max-h-[28rem] overflow-auto">
        <table className="min-w-full text-sm">
          <thead className="sticky top-0 z-10 bg-white">
            <tr className="text-left text-xs font-medium uppercase tracking-wide text-slate-500">
              <th className="px-2 py-1.5">Pool</th>
              <th className="px-2 py-1.5">Template</th>
              <th className="px-2 py-1.5 text-right">Ready</th>
              <th className="px-2 py-1.5 text-right">Desired</th>
              <th className="px-2 py-1.5 text-right">Creating</th>
              <th className="px-2 py-1.5 text-right">Failed</th>
              <th className="px-2 py-1.5 text-right">Fill</th>
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
                  className={
                    "cursor-pointer border-t border-slate-200 tabular-nums hover:bg-slate-50 " +
                    (failing ? "bg-rose-50/70" : under ? "bg-amber-50/60" : "")
                  }
                >
                  <td className="px-2 py-1.5 font-medium text-slate-900">{pool.name}</td>
                  <td className="px-2 py-1.5 text-slate-600">{pool.templateRef}</td>
                  <td className="px-2 py-1.5 text-right">{pool.readyReplicas}</td>
                  <td className="px-2 py-1.5 text-right">{pool.desiredReplicas}</td>
                  <td className="px-2 py-1.5 text-right">{pool.creatingReplicas}</td>
                  <td className="px-2 py-1.5 text-right">
                    {pool.failedReplicas > 0 ? (
                      <Badge tone="danger">{pool.failedReplicas}</Badge>
                    ) : (
                      pool.failedReplicas
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <Badge tone={under ? "warning" : "success"}>{Math.round(pool.fillRatio * 100)}%</Badge>
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
