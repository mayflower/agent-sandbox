import type { WarmPoolLiveView } from "@agent-sandbox/dashboard-shared";

import { useFilters } from "@/lib/filters";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

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
      <CardHeader className="flex-row items-baseline justify-between gap-3 space-y-0 p-3 pb-2">
        <CardTitle className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Warm pools
        </CardTitle>
        <span className="text-[11px] text-muted-foreground tabular-nums">
          {totalReady}/{totalDesired}
          {underfilled > 0 ? ` · ${underfilled} short` : ""}
        </span>
      </CardHeader>
      <CardContent className="p-3 pt-0">
        <ul className="max-h-[28rem] space-y-0.5 overflow-y-auto pr-1">
          {warmPools.map((pool) => {
            const under = pool.readyReplicas < pool.desiredReplicas;
            const failing = pool.failedReplicas > 0;
            const pct = Math.round(pool.fillRatio * 100);
            const tone = failing
              ? "text-rose-600 dark:text-rose-400"
              : under
                ? "text-amber-600 dark:text-amber-400"
                : "text-emerald-600 dark:text-emerald-400";
            const barColor = failing ? "bg-rose-500" : under ? "bg-amber-500" : "bg-emerald-500";
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
                  className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-accent hover:text-accent-foreground"
                  title={`${pool.name} · ready ${pool.readyReplicas}/${pool.desiredReplicas} · creating ${pool.creatingReplicas} · failed ${pool.failedReplicas}`}
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{pool.name}</span>
                  <span className="w-12 shrink-0 overflow-hidden rounded bg-muted">
                    <span
                      className={cn("block h-1", barColor)}
                      style={{ width: `${Math.min(100, pct)}%` }}
                      aria-hidden
                    />
                  </span>
                  <span className="w-10 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
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
      </CardContent>
    </Card>
  );
}
